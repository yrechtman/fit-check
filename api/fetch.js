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

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Failed to fetch: ${response.statusText}` });
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
  // Extract title
  const titleMatch = html.match(/<h1[^>]*class="[^"]*x-item-title[^"]*"[^>]*>.*?<span[^>]*>([^<]+)<\/span>/s) 
    || html.match(/<h1[^>]*>([^<]+)<\/h1>/)
    || html.match(/<title>([^<|]+)/);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Extract price
  const priceMatch = html.match(/itemprop="price"[^>]*content="([^"]+)"/)
    || html.match(/<span[^>]*class="[^"]*ux-textspans--BOLD[^"]*"[^>]*>\s*\$?([\d,.]+)\s*<\/span>/)
    || html.match(/\$\s*([\d,.]+)/);
  const price = priceMatch ? priceMatch[1].trim() : '';

  // Extract condition
  const conditionMatch = html.match(/Condition:<\/span>.*?<span[^>]*>([^<]+)<\/span>/s)
    || html.match(/"conditionDisplayName"\s*:\s*"([^"]+)"/)
    || html.match(/itemprop="itemCondition"[^>]*>([^<]+)</);
  const condition = conditionMatch ? conditionMatch[1].trim() : '';

  // Extract description - try multiple patterns
  const descMatch = html.match(/<div[^>]*id="viTabs_0_is"[^>]*>([\s\S]*?)<\/div>/)
    || html.match(/<div[^>]*class="[^"]*item-description[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  let description = '';
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

  // Extract item specifics (size, brand, measurements, etc.)
  const specifics = {};
  const specificsRegex = /<dt[^>]*>([^<]+)<\/dt>\s*<dd[^>]*>([^<]+)<\/dd>/g;
  let match;
  while ((match = specificsRegex.exec(html)) !== null) {
    const key = match[1].replace(/:$/, '').trim();
    const value = match[2].trim();
    if (key && value) specifics[key] = value;
  }

  // Also try JSON-LD data
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">(\{[^<]+\})<\/script>/);
  if (jsonLdMatch) {
    try {
      const jsonLd = JSON.parse(jsonLdMatch[1]);
      if (jsonLd.name && !title) title = jsonLd.name;
      if (jsonLd.offers?.price && !price) price = jsonLd.offers.price;
      if (jsonLd.brand?.name) specifics['Brand'] = jsonLd.brand.name;
    } catch {}
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
  
  if (description) {
    summary += `\nDescription:\n${description.slice(0, 2000)}`;
    if (description.length > 2000) summary += '...';
  }

  return {
    title,
    price,
    condition,
    specifics,
    description: description.slice(0, 3000),
    summary: summary || 'Could not parse listing details. Please paste the listing content manually.'
  };
}
