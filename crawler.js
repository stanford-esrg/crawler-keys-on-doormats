const puppeteer = require('puppeteer');
const fs = require('fs');
const csv = require('csv-parser');
const { format } = require('date-fns');
const sqlite3 = require('sqlite3');
const path = require('path');
const tldjs = require('tldjs');
const { storeData, getDb, setDbPath, closeDb } = require('./utils/helpers');
const { setDynamicConfig } = require('./utils/configs');

// Failure logging function
function logFailure(url, error, attempt, timeout) {
  const timestamp = new Date().toISOString();
  const logEntry = `${timestamp} | ${url} | Attempt ${attempt} | Timeout ${timeout}ms | Error: ${error.message}\n`;
  
  // Calculate the same date format as used for DB paths
  const now = new Date();
  const dateStr = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()}`;
  
  // Use container-specific log file to avoid race conditions
  const containerId = containerConfig.containerId || 'unknown';
  const logFile = path.join('/home/XXXX-4/crawler/output', dateStr, 'logs', `crawler-failures-container-${containerId}.log`);
  const logDir = path.dirname(logFile);
  
  // Ensure log directory exists
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  
  try {
    fs.appendFileSync(logFile, logEntry);
  } catch (err) {
    console.error('Failed to write to failure log:', err.message);
  }
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    containerId: 1,
    totalContainers: 1,
    websites: []
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    // Handle --key=value format
    if (arg.startsWith('--container-id=')) {
      config.containerId = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--total-containers=')) {
      config.totalContainers = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--websites=')) {
      const websitesStr = arg.split('=')[1];
      if (websitesStr && websitesStr.trim()) {
        config.websites = websitesStr.trim().split(',').filter(Boolean);
      }
    }
    // Handle --key value format
    else if (arg === '--container-id' && i + 1 < args.length) {
      config.containerId = parseInt(args[i + 1]);
    } else if (arg === '--total-containers' && i + 1 < args.length) {
      config.totalContainers = parseInt(args[i + 1]);
    } else if (arg === '--websites' && i + 1 < args.length) {
      const websitesStr = args[i + 1];
      if (websitesStr && websitesStr.trim()) {
        config.websites = websitesStr.trim().split(',').filter(Boolean);
      }
    }
  }
  
  return config;
}

const containerConfig = parseArgs();
console.log(`DEBUG: Raw args:`, process.argv);
console.log(`DEBUG: Parsed config:`, containerConfig);
console.log(`Container ${containerConfig.containerId}/${containerConfig.totalContainers} starting...`);

let browser;

// Directory management
class CrawlerManager {
  constructor() {
    this.userDataDir = null;
  }

  async createUserDataDir() {
    const dir = path.join(__dirname, 'chrome-user-data', `session-${Date.now()}`);
    if (!fs.existsSync(path.dirname(dir))) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
    }
    this.userDataDir = dir;
    return dir;
  }

  cleanupUserDataDir() {
    if (this.userDataDir && fs.existsSync(this.userDataDir)) {
      try {
        fs.rmSync(this.userDataDir, { recursive: true, force: true });
        console.log(`Cleaned up user data directory`);
      } catch (error) {
        console.error(`Failed to cleanup user data directory: ${error.message}`);
      }
    }
  }

  async setupBrowser() {
    const userDataDir = await this.createUserDataDir();
    
    // Always use headed mode with VNC support
    const isDocker = process.env.CONTAINER_ID !== undefined;
    
    const launchOptions = {
      headless: false, // Always headed mode
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-infobars',
        '--window-size=1280,800',
        '--disable-features=CookieDeprecationLabel,CookieDeprecationLabelChip',
        '--disable-features=TrackingProtection3pc',
        '--allow-third-party-cookies',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--ignore-certificate-errors',
        '--ignore-ssl-errors',
        '--ignore-certificate-errors-spki-list',
        '--allow-running-insecure-content',
        '--disable-web-security'
      ],
      userDataDir: userDataDir
    };
    
    // Set executable path based on environment
    if (isDocker) {
      // Docker uses system Chrome
      launchOptions.executablePath = '/usr/bin/google-chrome';
    } else {
      // Local development uses local Chrome
      launchOptions.executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    }

    try {
      browser = await puppeteer.launch(launchOptions);
      return browser;
    } catch (error) {
      console.error('Failed to launch browser:', error.message);
      throw error;
    }
  }

  async setupPage(page) {
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    return page;
  }
}

async function setupDatabase(dbPath) {
  const outputDir = path.dirname(dbPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Also create JSON directory
  const jsonDir = path.join(path.dirname(outputDir), 'JSON');
  if (!fs.existsSync(jsonDir)) {
    fs.mkdirSync(jsonDir, { recursive: true });
  }

  // Use the helpers.js database management instead of creating a separate connection
  const db = await getDb();
  
  await db.run(`CREATE TABLE IF NOT EXISTS requests (
    site_id TEXT,
    site TEXT, 
    url TEXT, 
    method TEXT,   
    request_time TEXT, 
    headers TEXT,
    payload TEXT, 
    resourceType TEXT,  
    current_url TEXT, 
    current_etld TEXT, 
    target_etld TEXT, 
    third_party INTEGER
  )`);

  await db.run(`CREATE TABLE IF NOT EXISTS responses (
    site_id TEXT,
    site TEXT, 
    url TEXT, 
    response_code INTEGER,  
    response_time TEXT, 
    current_url TEXT, 
    current_etld TEXT, 
    target_etld TEXT, 
    third_party INTEGER,
    headers TEXT,
    content TEXT
  )`);
}

async function removeDuplicates() {
  const db = await getDb();
  
  console.log('Removing duplicates from database tables...');
  
  // Remove duplicates from requests table - all columns
  await db.run(`
    DELETE FROM requests WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM requests 
      GROUP BY site_id, site, url, method, request_time, headers, payload, resourceType, current_url, current_etld, target_etld, third_party
    )
  `);
  
  // Remove duplicates from responses table - all columns
  await db.run(`
    DELETE FROM responses WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM responses 
      GROUP BY site_id, site, url, response_code, response_time, current_url, current_etld, target_etld, third_party, headers, content
    )
  `);
  
  console.log('✓ Duplicates removed successfully.');
}

async function handleRequest(request, entry, page) {
  const [siteId, siteUrl] = entry;
  const currentPageUrl = await page.url();
  const targetUrl = request.url();

  const currentEtld = tldjs.getDomain(currentPageUrl);
  const targetEtld = tldjs.getDomain(targetUrl);
  const thirdParty = currentEtld !== targetEtld ? 1 : 0;

  let payload = null;
  try {
    const postData = request.postData();
    if (postData) {
      payload = postData;
    }
  } catch (e) {
    // Ignore payload errors
  }

  const resourceType = request.resourceType();
  const headers = request.headers();

  // Store request
  await storeData("requests", [
    siteId,
    siteUrl,
    targetUrl,
    request.method(),
    format(new Date(), 'yyyy-MM-dd HH:mm:ss.SSS'),
    JSON.stringify(headers),
    payload,
    resourceType,
    currentPageUrl,
    currentEtld,
    targetEtld,
    thirdParty
  ]);
}

async function handleResponse(response, entry, page) {
  const [siteId, siteUrl] = entry;
  const currentPageUrl = await page.url();
  const targetUrl = response.url();
  const currentEtld = tldjs.getDomain(currentPageUrl);
  const targetEtld = tldjs.getDomain(targetUrl);
  const thirdParty = currentEtld !== targetEtld ? 1 : 0;
  const headers = response.headers();
  let content = '';
  const resourceType = response.request().resourceType();

  if (['document', 'script', 'stylesheet', 'xhr', 'fetch', 'other'].includes(resourceType)) {
    try {
      content = await response.text();
    } catch (err) {
      content = '';
    }
  }

  await storeData("responses", [
    siteId,
    siteUrl,
    targetUrl,
    response.status(),
    format(new Date(), 'yyyy-MM-dd HH:mm:ss.SSS'),
    currentPageUrl,
    currentEtld,
    targetEtld,
    thirdParty,
    JSON.stringify(headers),
    content
  ]);
}

async function startCrawler(urls) {
    console.log('Starting crawler...');

  const crawlerManager = new CrawlerManager();

    for (const entry of urls) {
      const siteURL = entry[1];

    // Add protocol if missing
    let url = siteURL.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
      entry[1] = url;
    }

    // Create output directory structure with DB and JSON subdirectories
    const now = new Date();
    const dateStr = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()}`;
    const siteHostClean = url.replace(/^https?:\/\//, '').replace(/[^\w.-]/g, '_');
    const dbPath = path.join('/home/XXXX-4/crawler/output', dateStr, 'DB', `${siteHostClean}.db`);

    setDynamicConfig('db_name', dbPath);
    setDbPath(dbPath);
    await setupDatabase(dbPath);
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Starting crawl for: ${url}`);
    console.log(`${'='.repeat(80)}\n`);

    let page = null;
    try {
      try {
        browser = await crawlerManager.setupBrowser();
      } catch (browserError) {
        console.log('Browser setup warning:', browserError.message);
        console.log('Continuing with basic browser setup...');
        // Fallback to basic browser setup if setup fails
        const isDocker = process.env.CONTAINER_ID !== undefined;
        browser = await puppeteer.launch({
          headless: false,
          ignoreDefaultArgs: ['--enable-automation'],
          args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--disable-infobars',
            '--window-size=1280,800',
            '--disable-features=CookieDeprecationLabel,CookieDeprecationLabelChip',
            '--disable-features=TrackingProtection3pc',
            '--allow-third-party-cookies',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--ignore-certificate-errors',
            '--ignore-ssl-errors',
            '--ignore-certificate-errors-spki-list',
            '--allow-running-insecure-content',
            '--disable-web-security'
          ],
          executablePath: isDocker ? '/usr/bin/google-chrome' : (process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome')
        });
      }
      
      page = await browser.newPage();
      
      // Check if page was created successfully before proceeding
      if (!page) {
        console.log(`⚠️ Page creation failed for ${url} - skipping website`);
        throw new Error('Page creation failed');
      }

      // Progressive retry mechanism with increasing timeouts
      const timeouts = [60000, 120000, 300000]; // 60s, 2min, 5min
      let navigationSuccess = false;
      let lastError = null;

      for (let attempt = 1; attempt <= timeouts.length; attempt++) {
        const timeout = timeouts[attempt - 1];
        console.log(`Attempt ${attempt}/${timeouts.length} with ${timeout/1000}s timeout...`);
        
        // Setup page configuration
        try {
          await crawlerManager.setupPage(page);
          console.log('Page configuration applied');
        } catch (pageError) {
          console.log('Page setup warning:', pageError.message);
          console.log('Continuing without page configuration...');
          // Continue without page configuration - this is not a fatal error
        }
        
        // Event handlers
        page.on('request', request => handleRequest(request, entry, page));
        page.on('response', response => handleResponse(response, entry, page));
        
        try {
          // Set page to ignore certificate errors
          try {
            await page.setBypassCSP(true);
          } catch (cspError) {
            console.log(`⚠️ Failed to set CSP bypass: ${cspError.message}`);
            console.log('Continuing without CSP bypass...');
          }
          
          // Try to set extra HTTP headers, but don't fail if it times out
          try {
            await page.setExtraHTTPHeaders({
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.5',
              'Accept-Encoding': 'gzip, deflate',
              'DNT': '1',
              'Connection': 'keep-alive',
              'Upgrade-Insecure-Requests': '1'
            });
          } catch (headerError) {
            console.log(`⚠️ Failed to set extra HTTP headers: ${headerError.message}`);
            console.log('Continuing without custom headers...');
          }
          
          await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: timeout
          });
          console.log('Page loaded successfully.');
          navigationSuccess = true;
          break;
        } catch (error) {
          lastError = error;
          console.log(`Attempt ${attempt} failed: ${error.message}`);
          
          // Handle specific error types
          if (error.message.includes('net::ERR_CERT_COMMON_NAME_INVALID') || 
              error.message.includes('net::ERR_CERT_AUTHORITY_INVALID') ||
              error.message.includes('net::ERR_SSL_PROTOCOL_ERROR')) {
            console.log('Certificate error detected, trying with insecure flags...');
            try {
              await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: timeout
              });
              console.log('Page loaded successfully after certificate bypass.');
              navigationSuccess = true;
              break;
            } catch (certError) {
              console.log(`Certificate bypass also failed: ${certError.message}`);
            }
          }
          
          // Log the failure
          logFailure(url, error, attempt, timeout);
          
          if (attempt < timeouts.length) {
            console.log(`Retrying with increased timeout...`);
            // Wait a bit before retry
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            console.log(`All attempts failed for ${url} - skipping to next website`);
            console.error(`Final error: ${error.message}`);
          }
        }
      }

      // If all navigation attempts failed, skip the rest of the processing
      if (!navigationSuccess) {
        console.log(`⚠️ Skipping ${url} due to navigation failures`);
        // Don't throw error - just log and continue
        console.log(`⚠️ Continuing to next website despite navigation failure...`);
        return; // Exit gracefully instead of throwing
      }

      console.log('Waiting 15 seconds for dynamic content...');
      await new Promise(resolve => setTimeout(resolve, 15000));

      console.log(`✓ Successfully crawled ${url}`);

    } catch (error) {
      console.error(`✗ Error crawling ${url}:`, error.message);
      // Don't log full stack trace for ProtocolError to reduce noise
      if (!error.message.includes('ProtocolError') && !error.message.includes('timed out')) {
        console.error(error.stack);
      }
      console.log(`⚠️ Continuing to next website despite error...`);
    } finally {
      if (browser) await browser.close();
      
      // Remove duplicates after closing browser and before moving to next website
      try {
        await removeDuplicates();
      } catch (error) {
        console.error('Error removing duplicates:', error.message);
      }
      
      crawlerManager.cleanupUserDataDir();
    }
  }
}

async function main() {
  // Check if websites were provided via command line arguments
  if (containerConfig.websites.length === 0) {
    console.error('Error: No websites provided via --websites argument');
    console.error('Usage: node crawler.js --container-id=1 --total-containers=20 --websites="website1 website2 website3"');
    process.exit(1);
  }

  const containerWebsites = containerConfig.websites;
  console.log(`Container ${containerConfig.containerId} received ${containerWebsites.length} websites to process`);

  for (let i = 0; i < containerWebsites.length; i++) {
    const website = containerWebsites[i];
    console.log(`\n[${i + 1}/${containerWebsites.length}] Processing: ${website}`);

    const entry = [`site_${Date.now()}`, website];
    
    try {
      // Fresh browser instance for each website
      console.log(`🌐 Opening fresh browser instance for ${website}...`);
      await startCrawler([entry]);
      
      // Ensure browser is completely closed and data is saved
      console.log(`💾 Data saved for ${website}. Browser instance closed.`);
      
      // Close database connection for this website
      await closeDb();
    } catch (error) {
      console.error(`❌ Failed to process ${website}: ${error.message}`);
      console.log(`⚠️ Continuing to next website despite error...`);
      
      // Log the failure for this specific website
      logFailure(website, error, 0, 0);
    }
    
    if (i < containerWebsites.length - 1) {
      console.log('\nWaiting 5 seconds before next website...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  console.log(`\n✅ Container ${containerConfig.containerId} completed ${containerWebsites.length} websites!`);
}

process.on('SIGINT', async () => {
  console.log("\nGracefully shutting down...");

  if (browser) {
    await browser.close();
  }
  process.exit();
});

main().catch(console.error);
