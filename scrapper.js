const puppeteer = require('puppeteer');
const dotenv = require('dotenv');
const { setTimeout } = require('timers/promises');
const minimist = require('minimist');
const fs = require('fs');
dotenv.config();

function encodeBase64(str) {
  return Buffer.from(str).toString('base64');
}

function decodeBase64(str) {
  return Buffer.from(str, 'base64').toString('utf8');
}

function cacheUsernameAndPassword(username, password) {
  if (username && password) {
    fs.writeFileSync(
        '.env',
        `YOUR_USERNAME=${encodeBase64(username)}\nYOUR_PASSWORD=${encodeBase64(password)}`
    );
  }
}

function getUsernameAndPassword() {
  const args = minimist(process.argv.slice(2));
  if (args.username && args.password) {
    cacheUsernameAndPassword(args.username, args.password);
    return { username: args.username, password: args.password };
  }
  const username = decodeBase64(process.env.YOUR_USERNAME);
  const password = decodeBase64(process.env.YOUR_PASSWORD);
  return { username, password };
}

function getDownloadFileName(date) {
    const mm = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const dd = String(date.getDate()).padStart(2, '0');
    const yyyy = date.getFullYear();
    
    const formattedDate = `${mm}${dd}${yyyy}`;
    return `6491custbill${formattedDate}.pdf`;
}

(async () => {
  // 1. Launch Browser
  //    Set headless to false if you want to see the browser for debugging
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  
  try {
    // 2. Go to Login Page
    //    Replace this with PG&E’s actual login page URL
    await page.goto('https://m.pge.com/#login', { waitUntil: 'networkidle2' });

    // await logShadowHosts(page);
    // await clickRejectCookiesInShadowDom(page);
    const rejectButton = await page.waitForSelector('#onetrust-reject-all-handler', { visible: true });
    await rejectButton.click();

    // 3. Fill in username and password
    //    NOTE: The below selectors (#username, #password, #loginBtn) are just EXAMPLES!
    //    You will need to inspect PG&E’s login form in DevTools to find the correct selectors.
    const { username, password } = getUsernameAndPassword();
    await page.type('#usernameField', username);
    await page.type('#passwordField', password);

    // The cookie consent window is blocking the login button, need to wait for it to be hidden
    await page.waitForSelector('#onetrust-reject-all-handler', { hidden: true });

    const loginButton = await page.waitForSelector('#home_login_submit', { visible: true });
    await loginButton.click();

    // 4. Wait for post-login navigation (PG&E may redirect or show a 2FA page, etc.)
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    
    // 5. Navigate to the Billing History page
    //    (the URL you gave, or possibly a link from the account dashboard)
    await page.goto('https://m.pge.com/#myaccount/billing/history/4947606491-7', { waitUntil: 'networkidle2' });

    // 6. Wait for the bill entries to load
    //    Adjust the selector to something that definitely appears once bills are loaded:
    //    e.g., a table row or the "View up to 24 months of activity" link text
    const view24MonthBillsButton = await page.waitForSelector('#href-view-24month-history', { visible: true, timeout: 8000 });
    // 7. Click on the "View up to 24 months of activity" link
    await view24MonthBillsButton.click();

    await page.waitForSelector('tbody.desktop-pdpore-table.account-list-tbody.scrollTable');

    let idx = 0;
    let fileNames = [];

    const args = minimist(process.argv.slice(2));
    if (args.limit) {
      limit = parseInt(args.limit);
    } else {
      limit = Number.MAX_SAFE_INTEGER;
    }
    
    while (true) {
      // Get fresh row reference using XPath index
      const rows = await page.$$(
        '::-p-xpath(//tr[contains(@class, "billed_history_panel")][.//span[contains(text(), "Bill Charges")]])'
      );

      if (idx >= Math.min(rows.length, limit)) {
        console.log('No more rows to process, total downloaded files: ', fileNames.length);
        break;
      }

      const row = rows[idx];

      try {
        await row.evaluate(el => el.scrollIntoView({ behavior: "smooth", block: "start" }));
        await setTimeout(1000);

        const viewBillLink = await row.$('a[title="view bill pdf"]', {visible: true});
        console.log(viewBillLink);
        if (viewBillLink) {
            // Extract the data-date attribute value from the anchor element.
            const billTimestamp = await viewBillLink.evaluate(el => el.getAttribute('data-date'));
  
            // Convert the timestamp string to a number.
            const timestampNumber = parseInt(billTimestamp, 10);
            
            // Convert the millisecond timestamp into a Date object
            const billDate = new Date(timestampNumber);
            
            console.log('Bill Date:', billDate);
            await viewBillLink.click();
            await setTimeout(8000); // Wait for PDF download or navigation
            console.log(`Clicked and successfully downloaded ${idx} row`);
            fileNames.push(getDownloadFileName(billDate));
            idx++;
        }
      } catch (err) {
        console.log(`Skipping ${idx} row due to error: ${err.message}`);
        idx++;
      }
    }

    console.log(fileNames);

  } catch (error) {
    console.error('Error scraping PG&E bills:', error);
  } finally {
    await browser.close();
  }
})();
