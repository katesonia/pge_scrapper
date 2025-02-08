# PG&E Bill Scrapper

## Installation

Download the repo:

```bash
git clone https://github.com/zhaoyu-li/pge-bill-scrapper.git
```

If you haven't install node, run the following command to install it:

```bash
brew install node
```

Install the dependencies:

```bash
npm install
```

## Usage

Command to run the scrapper:

```bash
node scrapper.js --url <url_to_pge_billings> --username <your_username> --password <your_password> --last_n_months <last_n_months_to_download>
```

Arguments:

- username: Your username for PG&E
- password: Your password for PG&E
- last_n_months: Optional limit of files to download. Default is the last 24 months, the longest time range PG&E stores the bills.
- url: Required url to the PG&E billings page. Default is the PG&E billings page.
