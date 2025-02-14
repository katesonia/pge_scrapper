const { createWorker } = require("tesseract.js");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

async function pdfToImage(pdfPath, outputPath, pageNumber = 1) {
  try {
    // Construct the ImageMagick convert command
    // [0] specifies first page, density 300 for better quality
    const command = `magick -density 150 "${pdfPath}"[${
      pageNumber - 1
    }] -quality 100 "${outputPath}"`;

    console.log("Executing command:", command);

    // Execute the command
    const { stdout, stderr } = await execPromise(command);
    if (stderr) {
      console.error("Convert stderr:", stderr);
    }

    console.log(`Converted page ${pageNumber} to image: ${outputPath}`);
  } catch (err) {
    console.error("Error converting PDF to image: ", err);
    throw err;
  }
}

async function doOCR(imagePath) {
  const worker = await createWorker();
  try {
    console.log(`Starting OCR on image: ${imagePath}`);
    const {
      data: { text },
    } = await worker.recognize(imagePath);
    // console.log(`OCR Result:\n${text}`);
    await worker.terminate();
    return text;
  } catch (err) {
    console.error("Error during OCR: ", err);
    throw err;
  }
}

function extractCharges(ocrText) {
  const deliveryChargesMatch = ocrText.match(
    /Current PG&E Electric Delivery Charges \$?(\d+\.\d{2})/
  );
  const generationChargesMatch = ocrText.match(
    /San Jose Clean Energy Electric Generation Charges \$?(\d+\.\d{2})/
  );
  const gasChargesMatch = ocrText.match(/Current Gas Charges \$?(\d+\.\d{2})/);

  return {
    pgeElectricDelivery: deliveryChargesMatch
      ? parseFloat(deliveryChargesMatch[1])
      : null,
    sanJoseCleanEnergy: generationChargesMatch
      ? parseFloat(generationChargesMatch[1])
      : null,
    gasCharges: gasChargesMatch ? parseFloat(gasChargesMatch[1]) : null,
  };
}

async function loadFiles(fileNames) {
  let billings = {};
  // Ensure the output directory exists.
  const outputDir = path.join(__dirname, "images");
  if (!fs.existsSync(outputDir)) {
    console.log(`Creating output directory: ${outputDir}`);
    fs.mkdirSync(outputDir);
  }
  await Promise.all(
    fileNames.map(async (fileName) => {
      // Update this if your PDF file is located somewhere else.
      const filePath = path.join(process.env.HOME, "Downloads", fileName);

      try {
        // Convert the first page of the PDF to an image.
        const imagePath = path.join(
          outputDir,
          fileName.replace(".pdf", ".png")
        );
        if (!fs.existsSync(imagePath)) {
          await pdfToImage(filePath, imagePath, (pageNumber = 1));
        }
        // Perform OCR on the generated image.
        const extractedText = await doOCR(imagePath);
        const charges = extractCharges(extractedText);
        billings[fileName] = charges;
      } catch (err) {
        console.error("Error processing PDF:", err);
        return null;
      }
    })
  );
  return billings;
}

function parseDate(dateString) {
  if (!/^\d{8}$/.test(dateString)) {
    throw new Error("Invalid date format. Expected MMDDYYYY.");
  }

  const month = parseInt(dateString.substring(0, 2), 10);
  const day = parseInt(dateString.substring(2, 4), 10);
  const year = parseInt(dateString.substring(4, 8), 10);

  return new Date(year, month - 1, day); // Month is zero-based in JS Date
}

async function parsePgeBillingFiles(fileNames) {
  const billings = await loadFiles(fileNames);
  for (const [fileName, charge] of Object.entries(billings)) {
    const dateStr = fileName.split("custbill")[1].split(".")[0];
    const date = parseDate(dateStr);
    const formattedDate = formatDateToYYYYMMDD(date);
    charge["date"] = formattedDate;
  }
  console.log(billings);
  writeBillingsToCSV(billings, "billings.csv");
  return billings;
}

function formatDateToYYYYMMDD(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0"); // Ensure two digits
  const day = String(date.getDate()).padStart(2, "0"); // Ensure two digits

  return `${year}-${month}-${day}`;
}

function writeBillingsToCSV(data, filename) {
  const headers = [
    "Date",
    "PG&E Electric Delivery",
    "San Jose Clean Energy",
    "Energy Charges",
    "Gas Charges",
  ];
  const rows = Object.entries(data).map(([file, details]) => {
    return [
      details.date,
      details.pgeElectricDelivery,
      details.sanJoseCleanEnergy,
      (details.pgeElectricDelivery + details.sanJoseCleanEnergy).toFixed(2),
      details.gasCharges,
    ].join(",");
  });

  const csvContent = [headers.join(","), ...rows].join("\n");
  fs.writeFileSync(filename, csvContent, "utf8");
}

module.exports = {
  parsePgeBillingFiles,
};
