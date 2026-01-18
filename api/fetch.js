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
        if (jsonLd.offers?.price) price = jsonLd.offers.price;
        if (jsonLd.offers?.priceCurrency) price = jsonLd.offers.price;
        if (jsonLd.brand?.name) specifics['Brand'] = jsonLd.brand.name;
        if (jsonLd.description) description = jsonLd.description;
      }
    } catch {}
  }

  // Fallback: Extract title from meta or h1
  if (!title) {
    const metaTitleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
    if (metaTitleMatch) title = metaTitleMatch[1];
  }
  if (!title) {
    const h1Match = html.match(/<h1[^>]*class="[^"]*x-item-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) {
      title = h1Match[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  // Extract price - look for the actual price display, not item numbers
  if (!price) {
    // Look for price in the specific eBay price container
    const priceContainerMatch = html.match(/class="[^"]*x-price-primary[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    if (priceContainerMatch) {
      const priceText = priceContainerMatch[1].replace(/<[^>]+>/g, '');
      const priceNum = priceText.match(/\$?([\d,]+\.?\d*)/);
      if (priceNum) price = priceNum[1];
    }
  }
  if (!price) {
    // Try itemprop price
    const itempropMatch = html.match(/itemprop="price"[^>]*content="([\d.]+)"/i);
    if (itempropMatch) price = itempropMatch[1];
  }

  // Extract condition
  const conditionMatch = html.match(/data-testid="ux-labels-values[^"]*condition[^"]*"[^>]*>[\s\S]*?<span[^>]*class="[^"]*ux-textspans--BOLD[^"]*"[^>]*>([^<]+)/i)
    || html.match(/"conditionDisplayName"\s*:\s*"([^"]+)"/i)
    || html.match(/Condition:[\s\S]*?<span[^>]*>([^<]+)<\/span>/i);
  if (conditionMatch) condition = conditionMatch[1].trim();

  // Extract item specifics from the specifics section
  // eBay uses a structure like: <div class="ux-labels-values__labels"><span>Size</span></div><div class="ux-labels-values__values"><span>XLT</span></div>
  const specificsSection = html.match(/About this item[\s\S]*?(?=<div[^>]*class="[^"]*vim)/i);
  if (specificsSection) {
    const labelValuePairs = specificsSection[0].matchAll(/ux-labels-values__labels[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>[\s\S]*?ux-labels-values__values[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/gi);
    for (const pair of labelValuePairs) {
      const key = pair[1].trim();
      const value = pair[2].trim();
      if (key && value && !key.includes('...')) {
        specifics[key] = value;
      }
    }
  }

  // Alternative: try to find specifics in a different format
  const specRows = html.matchAll(/<div[^>]*class="[^"]*ux-layout-section-evo__col[^"]*"[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>[\s\S]*?<span[^>]*class="[^"]*ux-textspans--BOLD[^"]*"[^>]*>([^<]+)<\/span>/gi);
  for (const row of specRows) {
    const key = row[1].trim();
    const value = row[2].trim();
    if (key && value && key.length < 30 && !specifics[key]) {
      specifics[key] = value;
    }
  }

  // Extract seller description - this is often in an iframe or loaded dynamically
  // Look for the description section
  if (!description) {
    const descMatch = html.match(/Item description from the seller[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>[\s\S]*?(?:About this item|Report this item)/i);
    if (descMatch) {
      description = descMatch[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  // Try another pattern for description
  if (!description || description.length < 20) {
    const descMatch2 = html.match(/<div[^>]*id="desc_div"[^>]*>([\s\S]*?)<\/div>/i)
      || html.match(/<div[^>]*class="[^"]*d-item-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (descMatch2) {
      description = descMatch2[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
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
  
  if (description && description.length > 10) {
    summary += `\nSeller Description:\n${description.slice(0, 3000)}`;
    if (description.length > 3000) summary += '...';
  }

  if (!summary || summary.length < 50) {
    summary = 'Could not parse listing details. Please paste the listing content manually.';
  }

  return {
    title,
    price,
    condition,
    specifics,
    description: description.slice(0, 3000),
    summary
  };
}
