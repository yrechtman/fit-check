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

  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ScrapingBee API key not configured' });
  }

  try {
    // First pass: get main page
    const scrapingBeeUrl = `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}&url=${encodeURIComponent(url)}&render_js=true&wait=3000`;
    
    const response = await fetch(scrapingBeeUrl);

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: `ScrapingBee error: ${errorText}` });
    }

    const html = await response.text();
    
    // Parse main listing info
    let listing = parseEbayListing(html);
    
    // Second pass: try to get iframe description if we didn't find one
    if (!listing.description || listing.description.length < 50) {
      const iframeUrl = extractDescriptionIframeUrl(html);
      if (iframeUrl) {
        try {
          const iframeResponse = await fetch(
            `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}&url=${encodeURIComponent(iframeUrl)}&render_js=false`
          );
          if (iframeResponse.ok) {
            const iframeHtml = await iframeResponse.text();
            const iframeDescription = parseIframeDescription(iframeHtml);
            if (iframeDescription && iframeDescription.length > (listing.description?.length || 0)) {
              listing.description = iframeDescription;
              // Rebuild summary with new description
              listing.summary = buildSummary(listing);
            }
          }
        } catch (e) {
          // Iframe fetch failed, continue with what we have
          console.error('Iframe fetch failed:', e.message);
        }
      }
    }
    
    return res.status(200).json(listing);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

function extractDescriptionIframeUrl(html) {
  // eBay description iframes typically have URLs like:
  // https://vi.vipr.ebaydesc.com/ws/eBayISAPI.dll?ViewItemDescV4&item=...
  // or embedded in data attributes
  
  const patterns = [
    /iframe[^>]*src="(https?:\/\/vi\.vipr\.ebaydesc\.com[^"]+)"/i,
    /iframe[^>]*src="(https?:\/\/[^"]*ebaydesc[^"]+)"/i,
    /"descriptionUrl"\s*:\s*"([^"]+)"/i,
    /data-src="(https?:\/\/vi\.vipr\.ebaydesc\.com[^"]+)"/i,
    /"iframeUrl"\s*:\s*"([^"]+ebaydesc[^"]+)"/i,
  ];
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      // Unescape any escaped characters
      return match[1].replace(/\\u002F/g, '/').replace(/\\/g, '');
    }
  }
  
  return null;
}

function parseIframeDescription(html) {
  // The iframe content is usually simpler HTML with the actual description
  // Strip all HTML and get the text
  let text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n\s*\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  
  // Clean up excessive whitespace while preserving line breaks for readability
  const lines = text.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  
  return lines.join('\n');
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

  // Extract title from og:title meta tag
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

  // Extract price
  if (!price) {
    const pricePatterns = [
      /itemprop="price"[^>]*content="([\d.]+)"/i,
      /"priceCurrency"\s*:\s*"USD"[\s\S]*?"price"\s*:\s*"?([\d.]+)/i,
      /"price"\s*:\s*"?([\d.]+)"?[\s\S]*?"priceCurrency"\s*:\s*"USD"/i,
      /class="[^"]*x-price-primary[^"]*"[^>]*>[\s\S]*?US\s*\$([\d,]+\.?\d*)/i,
      /US\s*\$([\d,]+\.\d{2})\s*<\/span>/i,
    ];
    
    for (const pattern of pricePatterns) {
      const match = html.match(pattern);
      if (match) {
        const priceVal = parseFloat(match[1].replace(/,/g, ''));
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
  const specPatterns = [
    /<span[^>]*class="[^"]*ux-textspans[^"]*"[^>]*>([^<]{1,30})<\/span>[\s\S]{0,200}?<span[^>]*class="[^"]*ux-textspans--BOLD[^"]*"[^>]*>([^<]+)<\/span>/gi,
    /<dt[^>]*>([^<]+)<\/dt>\s*<dd[^>]*>([^<]+)<\/dd>/gi,
  ];
  
  for (const pattern of specPatterns) {
    const matches = html.matchAll(pattern);
    for (const match of matches) {
      const key = match[1].replace(/:$/, '').trim();
      const value = match[2].trim();
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

  // Try to extract description from main page (sometimes it's inline, not in iframe)
  if (!description || description.length < 50) {
    // Look for description in various places
    const descPatterns = [
      // New eBay layout - look for the actual content div after the header
      /Item description from the seller<\/[^>]+>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/section/i,
      // Data attribute based
      /<div[^>]*data-testid="d-item-description"[^>]*>([\s\S]*?)<\/div>/i,
      // ID based
      /<div[^>]*id="viTabs_0_is"[^>]*>([\s\S]*?)<\/div>/i,
      // Class based
      /<div[^>]*class="[^"]*item-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      // Section with description
      /<section[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/section>/i,
    ];
    
    for (const pattern of descPatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const cleaned = cleanHtml(match[1]);
        if (cleaned.length > 50 && cleaned.length > (description?.length || 0)) {
          description = cleaned;
          break;
        }
      }
    }
  }

  const listing = { title, price, condition, specifics, description: (description || '').slice(0, 3000) };
  listing.summary = buildSummary(listing);
  
  return listing;
}

function cleanHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildSummary(listing) {
  let summary = '';
  if (listing.title) summary += `Title: ${listing.title}\n`;
  if (listing.price) summary += `Price: $${listing.price}\n`;
  if (listing.condition) summary += `Condition: ${listing.condition}\n`;
  
  if (Object.keys(listing.specifics).length > 0) {
    summary += '\nItem Specifics:\n';
    for (const [key, value] of Object.entries(listing.specifics)) {
      summary += `${key}: ${value}\n`;
    }
  }
  
  if (listing.description && listing.description.length > 20) {
    summary += `\nSeller Description:\n${listing.description.slice(0, 3000)}`;
    if (listing.description.length > 3000) summary += '...';
  } else {
    summary += '\n(Seller description not found - it may be in an iframe. Please paste it manually below.)';
  }

  if (!listing.title && !listing.price) {
    summary = 'Could not parse listing details. Please paste the listing content manually.';
  }

  return summary;
}
