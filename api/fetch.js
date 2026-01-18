export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter required' });
  }

  // Only allow eBay URLs for security
  const allowedDomains = ['ebay.com', 'www.ebay.com', 'ebay.co.uk', 'www.ebay.co.uk'];
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!allowedDomains.some(d => parsedUrl.hostname.endsWith(d))) {
      return res.status(400).json({ error: 'Only eBay URLs are supported' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // ScrapingBee API key from environment variable
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ScrapingBee API key not configured' });
  }

  try {
    // Use ScrapingBee with JS rendering enabled
    const scrapingBeeUrl = `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}&url=${encodeURIComponent(url)}&render_js=true&wait=3000`;
    
    const response = await fetch(scrapingBeeUrl);

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: `ScrapingBee error: ${errorText}` });
    }

    const html = await response.text();
    
    // Extract relevant listing info from eBay HTML
    const listing = parseEbayListing(html);
    
    return res.status(200).json(listing);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

function parseEbayListing(html) {
  let title = '';
  let price = '';
  let condition = '';
  let description = '';
  const specifics = {};

  // Try to extract JSON-LD data first (most reliable)
  const jsonLdMatches = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of jsonLdMatches) {
    try {
      const jsonLd = JSON.parse(match[1]);
      if (jsonLd['@type'] === 'Product' || jsonLd.name) {
        if (jsonLd.name) title = jsonLd.name;
        if (jsonLd.offers?.price) price = String(jsonLd.offers.price);
        if (jsonLd.brand?.name) specifics['Brand'] = jsonLd.brand.name;
        if (jsonLd.description) description = jsonLd.description;
      }
    } catch {}
  }

  // Extract title from og:title meta tag (very reliable)
  if (!title) {
    const ogTitleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i)
      || html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:title"/i);
    if (ogTitleMatch) {
      title = ogTitleMatch[1].replace(/ \| eBay$/, '').trim();
    }
  }
  
  // Fallback: page title
  if (!title) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      title = titleMatch[1].replace(/ \| eBay$/, '').trim();
    }
  }

  // Extract price - be very careful not to grab item numbers
  // Look for US dollar amounts that are reasonable prices (under $10000)
  if (!price) {
    // Look for the price in common eBay patterns
    const pricePatterns = [
      /itemprop="price"[^>]*content="([\d.]+)"/i,
      /"priceCurrency"\s*:\s*"USD"[\s\S]*?"price"\s*:\s*"?([\d.]+)/i,
      /"price"\s*:\s*"?([\d.]+)"?[\s\S]*?"priceCurrency"\s*:\s*"USD"/i,
      /class="[^"]*x-price-primary[^"]*"[^>]*>[\s\S]*?US\s*\$([\d,]+\.?\d*)/i,
      /US\s*\$([\d,]+\.\d{2})\s*<\/span>/i,
      /<span[^>]*>\s*US\s*\$([\d,]+\.\d{2})\s*<\/span>/i,
    ];
    
    for (const pattern of pricePatterns) {
      const match = html.match(pattern);
      if (match) {
        const priceVal = parseFloat(match[1].replace(/,/g, ''));
        // Sanity check: price should be between $0.01 and $50000
        if (priceVal > 0 && priceVal < 50000) {
          price = match[1].replace(/,/g, '');
          break;
        }
      }
    }
  }

  // Extract condition
  if (!condition) {
    const conditionPatterns = [
      /"conditionDisplayName"\s*:\s*"([^"]+)"/i,
      /Condition:<\/span>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i,
      /itemCondition"[^>]*>([^<]+)</i,
      /<span[^>]*class="[^"]*ux-icon-text[^"]*"[^>]*>([^<]*(?:New|Pre-owned|Used)[^<]*)<\/span>/i,
    ];
    
    for (const pattern of conditionPatterns) {
      const match = html.match(pattern);
      if (match && match[1].trim()) {
        condition = match[1].trim();
        break;
      }
    }
  }

  // Extract item specifics
  // Pattern 1: Look for labeled value pairs
  const specPatterns = [
    /<span[^>]*class="[^"]*ux-textspans[^"]*"[^>]*>([^<]{1,30})<\/span>[\s\S]{0,200}?<span[^>]*class="[^"]*ux-textspans--BOLD[^"]*"[^>]*>([^<]+)<\/span>/gi,
    /<dt[^>]*>([^<]+)<\/dt>\s*<dd[^>]*>([^<]+)<\/dd>/gi,
  ];
  
  for (const pattern of specPatterns) {
    const matches = html.matchAll(pattern);
    for (const match of matches) {
      const key = match[1].replace(/:$/, '').trim();
      const value = match[2].trim();
      // Filter out non-specifics
      if (key && value && 
          key.length < 25 && 
          value.length < 100 &&
          !key.match(/^(See|View|Read|Show|More|Less|\d)/i) &&
          !value.match(/^(See|View|Read|Show)/i)) {
        specifics[key] = value;
      }
    }
  }

  // Look for common specifics by name
  const commonSpecs = ['Size', 'Brand', 'Color', 'Material', 'Style', 'Type', 'Pattern', 'Sleeve Length', 'Fit', 'Department'];
  for (const spec of commonSpecs) {
    if (!specifics[spec]) {
      const specMatch = html.match(new RegExp(`>${spec}:?<[^>]*>[\\s\\S]*?<span[^>]*class="[^"]*BOLD[^"]*"[^>]*>([^<]+)`, 'i'))
        || html.match(new RegExp(`"${spec}"\\s*:\\s*"([^"]+)"`, 'i'));
      if (specMatch) {
        specifics[spec] = specMatch[1].trim();
      }
    }
  }

  // Extract seller description
  // eBay often loads this via iframe, but ScrapingBee should render it
  if (!description || description.length < 20) {
    const descPatterns = [
      /Item description from the seller[\s\S]*?<div[^>]*class="[^"]*"[^>]*>([\s\S]{20,}?)<\/div>[\s\S]*?(?:Shipping|About this item|Report)/i,
      /<div[^>]*id="viTabs_0_is"[^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*class="[^"]*item-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*data-testid="d-item-description"[^>]*>([\s\S]*?)<\/div>/i,
      /descriptionModule[\s\S]*?<div[^>]*>([\s\S]{50,}?)<\/div>/i,
    ];
    
    for (const pattern of descPatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const cleaned = match[1]
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim();
        
        if (cleaned.length > 20 && cleaned.length > (description?.length || 0)) {
          description = cleaned;
        }
      }
    }
  }

  // Build a text summary for Claude
  let summary = '';
  if (title) summary += `Title: ${title}\n`;
  if (price) summary += `Price: $${price}\n`;
  if (condition) summary += `Condition: ${condition}\n`;
  
  if (Object.keys(specifics).length > 0) {
    summary += '\nItem Specifics:\n';
    for (const [key, value] of Object.entries(specifics)) {
      summary += `${key}: ${value}\n`;
    }
  }
  
  if (description && description.length > 20) {
    summary += `\nSeller Description:\n${description.slice(0, 3000)}`;
    if (description.length > 3000) summary += '...';
  } else {
    summary += '\n(Seller description not found - it may be in an iframe. You can paste it manually below.)';
  }

  if (!title && !price) {
    summary = 'Could not parse listing details. Please paste the listing content manually.';
  }

  return {
    title,
    price,
    condition,
    specifics,
    description: (description || '').slice(0, 3000),
    summary
  };
}
