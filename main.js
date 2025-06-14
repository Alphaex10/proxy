const axios = require('axios');
const express = require('express');
const https = require('https');

const { URL } = require('url');

function getSubdomain(urlString) {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname;
    const parts = hostname.split('.');

    if (parts.length < 3) {
      return null;
    }

    return parts[0];
  } catch (error) {
    return null;
  }
}

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

let cookieJar = '';


let currentHost = "localhost:3000"

function validateUrl(url) {
  if (!url) return 'https://discord.com/';
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return `https://${url}`;
  }
  return url;
}

let storedBaseUrl = validateUrl();

async function fetchWebsiteContent(url, method = 'GET', body = null, originalHeaders) {
  try {
    const parsedBase = new URL(storedBaseUrl);
    const headers = originalHeaders || {};
    headers["origin"] = parsedBase.origin
    headers["referer"] = parsedBase.origin
    headers["Alt-Used"] = parsedBase.origin
    console.log(headers["urlClassification"])
    currentHost = headers["host"]
    delete headers["host"]
    //delete headers["x-forwarded-for"]
    //console.log(headers)
    const config = {
      method: method.toUpperCase(),
      url,
      headers,
      data: body,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      timeout: 30,
      httpsAgent: insecureAgent,
      validateStatus: null, // let us see non-2xx statuses
    };

    const response = await axios(config);

    // Save any cookies for next request
    if (response.headers['set-cookie']) {
      cookieJar = response.headers['set-cookie'].map(cookie => cookie.split(';')[0]).join('; ');
    }

    if (response.status < 400 || response.statusText === "OK") {
      console.log(method, response.status, response.statusText, url.substring(0, 75))
      return {
        success: true,
        data: response.data,
        contentType: response.headers['content-type'] || 'text/html',
        headers: response.headers,
        status: response.status
      };
    } else {
      const text = Buffer.from(response.data).toString('utf8');
      console.log("🚫", method, response.status, response.statusText, url.substring(0, 75))
      return {
        success: false,
        error: response.statusText,
        status: response.status || 500,
      };
    }

  } catch (error) {
    console.log("❗️🚫 INTERNAL ERROR:", error.message)
    return {
      success: false,
      error: error.message,
      status: error.response?.status || 500
    };
  }
}

function basicNetFetch(req, res, result, base) {
  const contentType = result.contentType;
  const protocol = req.secure ? 'https' : 'https';
  const proxyHost = `${protocol}://${currentHost}`;

  const baseOrigin = base.origin.replaceAll("https://", "");

  res.set('Content-Type', contentType);

  if (contentType.includes('text') || contentType.includes('json') || contentType.includes('javascript')) {
    const text = Buffer.from(result.data).toString('utf8');

    const baseDomain = new URL(storedBaseUrl).hostname;

    const rewritten = text.replace(/https:\/\/([\w.-]+)(\/[^\s"'<>]*)?/g, (match, fullHost, path = '') => {
      const hostParts = fullHost.split('.');
      if (hostParts.length < 2) return match;

      const subdomain = hostParts.length > 2 ? hostParts[0] : null;
      const mainDomain = hostParts.slice(-2).join('.');
      const targetDomain = fullHost;

      const hasQuery = path.includes('?');
      const separator = hasQuery ? '&' : '?';

      const proxyPath = `${path}${separator}`;

      if (targetDomain === baseDomain || targetDomain.endsWith('.' + baseDomain)) {
        // Same base: no temp base needed
        return `${proxyHost}${proxyPath}repl_subd=${subdomain || ''}`;
      } else {
        // External site: add temp base
        return `${proxyHost}${proxyPath}repl_tempBaseAddr=${targetDomain}`;
      }
    });


    const final = rewritten.replaceAll(baseOrigin, currentHost);

    return res.status(result.status).send(final);
  }

  return res.status(result.status).send(result.data);
}

function checkForQuery(req) {
  let sub = "";
  let tempBaseAddr = null;
  let permanentBaseUrl = null;

  // Separate params into internal repl_* and normal ones for forwarding
  const internalParams = {};
  const forwardParams = {};

  if (req.query && Object.keys(req.query).length > 0) {
    console.log("🌐🌐 QUERY DETECTED 🌐🌐");
    
    for (const key in req.query) {
      if (key.startsWith('repl_')) {
        internalParams[key] = req.query[key];
      } else {
        forwardParams[key] = req.query[key];
      }
    }

    // Handle internal repl params separately
    if (internalParams.repl_tempBaseAddr) {
      tempBaseAddr = validateUrl(internalParams.repl_tempBaseAddr);
    }
    if (internalParams.repl_url) {
      permanentBaseUrl = validateUrl(internalParams.repl_url);
      storedBaseUrl = permanentBaseUrl; // Only update storedBaseUrl on repl_url
    }
    if (internalParams.repl_subd) {
      sub = internalParams.repl_subd + ".";
    }
  }

  // Build query string from only forwardParams (exclude repl_ params)
  const forwardQueryString = Object.keys(forwardParams).length > 0
    ? "?" + Object.entries(forwardParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")
    : "";

  return { queryString: forwardQueryString, sub, tempBaseAddr };
}

async function handleSetBaseUrl(req, res) {
  let { queryString, sub, tempBaseAddr } = checkForQuery(req);
  let baseUrlToUse = tempBaseAddr || storedBaseUrl;
  let baseStrip = baseUrlToUse.replaceAll("https://", "");
  var path = req.params.path || []
  const requestedPath = path.join('/');
  const result = await fetchWebsiteContent("https://" + sub + baseStrip + requestedPath + queryString, req.method, req.body, req.headers);

  if (result.success) {
    const base = new URL(baseUrlToUse);
    basicNetFetch(req, res, result, base);
  } else {
    res.status(result.status || 500).send(
      `<h1>🚫 Base URL Error</h1><p>Could not fetch: ${"https://" + sub + baseStrip + queryString}<br><strong>Error:</strong> ${result.error}</p>`
    );
  }
}

async function handlePathRequest(req, res) {
  if (!storedBaseUrl) {
    return res.status(400).send(`<h1>No Base URL Set</h1><p>Visit /?repl_url=https://example.com first.</p>`);
  }

  let { queryString, sub, tempBaseAddr } = checkForQuery(req);
  let baseUrlToUse = tempBaseAddr || storedBaseUrl;  // Use temp base only for this request
  let baseStrip = baseUrlToUse.replaceAll("https://", "");
  var path = req.params.path || '';
  const requestedPath = path.join('/');
  var fullUrl = "https://" + sub + baseStrip + "/" + requestedPath + queryString;

  const result = await fetchWebsiteContent(fullUrl, req.method, req.body, req.headers);

  if (result.success) {
    const base = new URL(baseUrlToUse);
    basicNetFetch(req, res, result, base);
  } else {
    res.status(result.status || 500).send(
      `<h1>🚫 Path Error</h1><p>Could not reach the endpoint ${fullUrl} because of an error.<br><strong>Error:</strong> ${result.error}</p>`
    );
  }
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '150mb' }));
  app.use(express.urlencoded({ extended: true, limit: '150mb' }));
  app.use(express.raw({ type: '*/*', limit: '150mb' }));

  app.set('trust proxy', true);
  app.all('/', handleSetBaseUrl);
  app.all('/*path', handlePathRequest);

  return app;
}

function startServer(app, port = 3000) {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Proxy server running at http://localhost:${port}`);
  });
}

const app = createApp();
startServer(app, 3000);
