const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const dotenv = require("dotenv");
const { setTimeout } = require("timers/promises");
const minimist = require("minimist");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parsePgeBillingFiles } = require("./pdfparser");

dotenv.config();
puppeteer.use(StealthPlugin());

const ARGS = loadArgs();
const N_RETRY = 2;
const COOKIES_PATH = "./cookies.json";
const LOCAL_STORAGE_PATH = "./localstorage.json";

function loadArgs() {
  const args = minimist(process.argv.slice(2));
  if (args.last_n_months > 24) args.last_n_months = 24;
  if (args.url) {
    fs.writeFileSync(
      ".env",
      `URL="${args.url}"\nLAST_N_MONTHS=${args.last_n_months || 24}`
    );
  }

  const parsed_args = {
    url: process.env.URL,
    last_n_months: parseInt(process.env.LAST_N_MONTHS),
  };
  return parsed_args;
}

function getDownloadFileNameRegex(date) {
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0"); // Months are 0-based
  const yyyy = date.getUTCFullYear();

  return new RegExp(`^\\d+custbill${mm}\\d+${yyyy}\\.pdf$`);
}

function fileExistsWithRegex(regex) {
  const downloadDir = path.join(os.homedir(), "Downloads");
  const files = fs.readdirSync(downloadDir); // Get all files in Downloads
  const fileName = files.find((file) => regex.test(file)) || null; // Check if any file matches the regex
  return fileName;
}

async function handleCookieConsent(page) {
  try {
    console.log("Waiting for cookie consent window");
    const rejectButton = await page.waitForSelector(
      "#onetrust-reject-all-handler",
      { visible: true, timeout: 2000 }
    );

    if (rejectButton) {
      await rejectButton.click();
      // The cookie consent window is blocking the login button, need to wait for it to be hidden
      await page.waitForSelector("#onetrust-reject-all-handler", {
        hidden: true,
      });
    }
  } catch (err) {
    console.log("No cookie consent window found");
  }
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function loginAndRedirect(page, url) {
  try {
    await handleCookieConsent(page);
    // Go to Login Page
    console.log(`Initial navigation to ${url}`);
    await page.goto(url, { waitUntil: "networkidle2" });
    await setTimeout(randomDelay(2000, 4000));

    // Check if redirected to login page
    if (page.url().includes("login")) {
      console.log("Redirected to login page");
      const loggedIn = await page.$(".pge_coc-header-siginedin_gp");
      if (loggedIn) {
        console.log("Already logged in");
      } else {
        console.log(
          "\n***Pls manually fill in username and password in 5 mins***\n"
        );
        await page.waitForSelector("#home_login_submit", {
          visible: true,
        });
        await page.evaluate(() => {
          window.loginTriggered = false;

          // Listen for login button click
          document
            .querySelector("#home_login_submit")
            ?.addEventListener("click", () => {
              window.loginTriggered = true;
            });

          // Listen for Enter key in the password field
          document
            .querySelector("#passwordField")
            ?.addEventListener("keypress", (event) => {
              if (event.key === "Enter") {
                window.loginTriggered = true;
              }
            });
        });

        await page.waitForFunction(() => window.loginTriggered, {
          timeout: 300000,
        });

        // Wait for post-login navigation (PG&E may redirect or show a 2FA page, etc.)
        await page.waitForNavigation({ waitUntil: "networkidle2" });
        // Navigate to the Billing History page
        console.log(`After handling login, navigating to ${url} again...`);
        await page.goto(url, { waitUntil: "networkidle2" });
      }
    } else {
      console.log("Successfully goes to the billing history page");
    }

    // Wait for the bill entries to load
    const view24MonthBillsButton = await page.waitForSelector(
      "#href-view-24month-history",
      { visible: true, timeout: randomDelay(8000, 10000) }
    );
    await setTimeout(randomDelay(1000, 3000));
    // Click on the "View up to 24 months of activity" link
    await view24MonthBillsButton.click();
    await page.waitForSelector(
      "tbody.desktop-pdpore-table.account-list-tbody.scrollTable"
    );
    return true;
  } catch (err) {
    console.log("Failed to log in", err);
    return false;
  }
}

async function loginAndRedirectWithRetry(page, url, n_retry) {
  for (let i = 0; i < n_retry; i++) {
    const loggedIn = await loginAndRedirect(page, url);
    if (loggedIn) {
      console.log("Successfully logged in");
      await saveSession(page);
      return true;
    }
    console.log("Failed to log in, refreshing page and retrying...");
    await setTimeout(randomDelay(1000, 3000));
    await page.reload({ waitUntil: "networkidle2" });
    await setTimeout(randomDelay(5000, 6000));
  }

  console.log("Failed to log in after", n_retry, "retries");
  return false;
}

async function clickAndDownloadBills(page, limit) {
  let fileNames = [];
  try {
    for (let idx = 1; idx <= limit; idx++) {
      // Get fresh row reference using XPath index
      const row = await page.$(
        `::-p-xpath((//tr[contains(@class, "billed_history_panel")][.//span[contains(text(), "Bill Charges")]])[${idx}])`
      );
      if (!row) {
        console.log(`No row found for index ${idx}, skipping...`);
        continue;
      }

      console.log(`Processing row ${idx}`);
      try {
        await row.evaluate((el) =>
          el.scrollIntoView({ behavior: "smooth", block: "start" })
        );
        await setTimeout(randomDelay(1000, 3000));

        const viewBillLinks = await row.$$('a[title="view bill pdf"]', {
          visible: true,
        });
        for (const viewBillLink of viewBillLinks) {
          try {
            // Extract the data-date attribute value from the anchor element.
            const billTimestamp = await viewBillLink.evaluate((el) =>
              el.getAttribute("data-date")
            );
            // Convert the millisecond timestamp into a Date object
            const billDate = new Date(parseInt(billTimestamp, 10));
            const fileNameRegex = getDownloadFileNameRegex(billDate);
            let fileName = fileExistsWithRegex(fileNameRegex);
            if (fileName) {
              console.log(
                `File ${fileName} already exists, loading from local file, skip downloading...`
              );
              fileNames.push(fileName);
              continue;
            }

            await viewBillLink.click();
            await setTimeout(randomDelay(5000, 6000)); // Wait for PDF download or navigation
            console.log("Bill Date:", billDate);
            console.log(`Clicked and successfully downloaded ${fileName}`);
            fileName = fileExistsWithRegex(fileNameRegex);
            fileNames.push(fileName);
          } catch (err) {
            console.log(`Skip to the next clickable element: ${err}`);
          }
        }
      } catch (err) {
        console.log(`Skipping ${idx} row due to error: ${err.message}`);
      }
    }
  } catch (err) {
    console.error("Error clicking and downloading bills:", err);
  }
  return fileNames;
}

function allBillsDownloaded() {
  let fileNames = [];
  for (let i = 0; i < ARGS.last_n_months; i++) {
    let date = new Date();
    date.setMonth(date.getMonth() - i);
    const regex = getDownloadFileNameRegex(date);
    const fileName = fileExistsWithRegex(regex);
    if (!fileName) {
      return [];
    }
    fileNames.push(fileName);
  }
  return fileNames;
}

async function loadSession(page) {
  if (fs.existsSync(COOKIES_PATH)) {
    console.log("Loading session cookies...");
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, "utf8"));
    await page.setCookie(...cookies);
  } else {
    console.log("No saved cookies found.");
  }

  if (fs.existsSync(LOCAL_STORAGE_PATH)) {
    console.log("Loading session local storage...");
    const localStorageData = JSON.parse(
      fs.readFileSync(LOCAL_STORAGE_PATH, "utf8")
    );

    try {
      await page.evaluate((data) => {
        if (!window.localStorage) {
          console.log("Local storage is not accessible.");
          return;
        }
        for (let key in data) {
          localStorage.setItem(key, data[key]);
        }
      }, localStorageData);
      console.log("Local storage loaded.");
    } catch (err) {
      console.log("Error loading local storage:", err.message);
    }
  } else {
    console.log("No saved local storage found.");
  }
}

async function saveSession(page) {
  console.log("Saving session...");

  // Save cookies
  const cookies = await page.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));

  // Try to access local storage safely
  try {
    const localStorageData = await page.evaluate(() => {
      if (!window.localStorage) {
        return null;
      }
      let data = {};
      for (let key in localStorage) {
        data[key] = localStorage.getItem(key);
      }
      return data;
    });

    if (localStorageData) {
      fs.writeFileSync(
        LOCAL_STORAGE_PATH,
        JSON.stringify(localStorageData, null, 2)
      );
    }
  } catch (err) {
    console.log("Error accessing local storage:", err.message);
  }

  console.log("Session saved!\n");
}

async function scrape() {
  // 1. Launch Browser
  const browser = await puppeteer.launch({
    headless: false,
  });
  const page = await browser.newPage();
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36",
  ];
  await page.setUserAgent(
    userAgents[Math.floor(Math.random() * userAgents.length)]
  );
  await page.setExtraHTTPHeaders({
    "accept-language": "en-US,en;q=0.9",
    "upgrade-insecure-requests": "1",
  });
  await loadSession(page);

  //login
  if (!(await loginAndRedirectWithRetry(page, ARGS.url, N_RETRY))) {
    return false;
  }

  let fileNames = [];
  try {
    let limit = ARGS.last_n_months;
    console.log(`Getting the last ${limit} months of bills`);
    fileNames = await clickAndDownloadBills(page, limit);
    console.log("Downloaded files:\n", fileNames);
  } catch (error) {
    console.error("Error scraping PG&E bills:", error);
    return [];
  } finally {
    await browser.close();
    return fileNames;
  }
}

async function main() {
  let fileNames = allBillsDownloaded();
  if (fileNames.length === 0) {
    console.log("Not all bill pdfs are downloaded, start scraping...");
    fileNames = await scrape();
  } else {
    console.log("All bill pdfs are downloaded, start parsing...");
  }
  if (fileNames.length === 0) {
    console.log("Failed to scrape PG&E bills");
    return;
  }
  await parsePgeBillingFiles(fileNames);
  console.log("Parsed billings and saved to billings.csv\n");
}

main();
