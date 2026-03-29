const fs = require('fs');
const file = '/home/mohdaffan/.gemini/antigravity/brain/304db41d-24ef-4098-925e-0e202822450b/advanced_youtube_workflow.json';
let json = JSON.parse(fs.readFileSync(file, 'utf8'));

// Base nodes
const webhook = json.nodes.find(n => n.name === 'Webhook Initiate');
const ifNode = json.nodes.find(n => n.name === '3. Check Metadata Source (IF Node)');
const fetchSheets = json.nodes.find(n => n.name === '4A. Fetch Metadata from Sheets');
const initSheets = json.nodes.find(n => n.name === '5A. Initiate YouTube Upload (Sheets)');
const initManual = json.nodes.find(n => n.name === '4B. Initiate YouTube Upload (Manual)');
const alertWebpilot = json.nodes.find(n => n.name === '6. Send Success Log to WebPilot');

// Drive Nodes templates
const fetchDriveTpl = json.nodes.find(n => n.name.includes('Fetch Oldest Video from Drive'));
const downloadDriveTpl = json.nodes.find(n => n.name.includes('Download Video Binary'));
const uploadSheetsTpl = json.nodes.find(n => n.name === '5B. Upload Binary (Sheets)');
const uploadManualTpl = json.nodes.find(n => n.name === '4C. Upload Binary (Manual)');

// Clone functions
const clone = (obj) => JSON.parse(JSON.stringify(obj));

// Create fresh Drive nodes for Sheets
const fetchDriveSheets = clone(fetchDriveTpl);
fetchDriveSheets.name = '5B.1 Fetch Oldest Video from Drive (Sheets)';
fetchDriveSheets.id = 'fetch-drive-sheets';
fetchDriveSheets.position = [1460, 240];

const downloadDriveSheets = clone(downloadDriveTpl);
downloadDriveSheets.name = '5B.2 Download Video Binary (Sheets)';
downloadDriveSheets.id = 'download-binary-sheets';
downloadDriveSheets.position = [1680, 240];

const uploadBinarySheets = clone(uploadSheetsTpl);
uploadBinarySheets.position = [1900, 240];
uploadBinarySheets.parameters.url = "={{ $('5A. Initiate YouTube Upload (Sheets)').first().json.headers.location }}";

// Create fresh Drive nodes for Manual
const fetchDriveManual = clone(fetchDriveTpl);
fetchDriveManual.name = '4C.1 Fetch Oldest Video from Drive (Manual)';
fetchDriveManual.id = 'fetch-drive-manual';
fetchDriveManual.position = [1200, 560];

const downloadDriveManual = clone(downloadDriveTpl);
downloadDriveManual.name = '4C.2 Download Video Binary (Manual)';
downloadDriveManual.id = 'download-binary-manual';
downloadDriveManual.position = [1420, 560];

const uploadBinaryManual = clone(uploadManualTpl);
uploadBinaryManual.position = [1640, 560];
uploadBinaryManual.parameters.url = "={{ $('4B. Initiate YouTube Upload (Manual)').first().json.headers.location }}";

// Clean up Alert node position
alertWebpilot.position = [2160, 400];

// Align starting nodes
webhook.position = [0, 400];
ifNode.position = [240, 400];
fetchSheets.position = [500, 240];
initSheets.position = [720, 240];
initManual.position = [500, 560];

// Assemble nodes
json.nodes = [
  webhook,
  ifNode,
  fetchSheets,
  initSheets,
  fetchDriveSheets,
  downloadDriveSheets,
  uploadBinarySheets,
  initManual,
  fetchDriveManual,
  downloadDriveManual,
  uploadBinaryManual,
  alertWebpilot
];

// Rebuild connections
json.connections = {
  "Webhook Initiate": {
    "main": [
      [ { "node": "3. Check Metadata Source (IF Node)", "type": "main", "index": 0 } ]
    ]
  },
  "3. Check Metadata Source (IF Node)": {
    "main": [
      [ { "node": "4A. Fetch Metadata from Sheets", "type": "main", "index": 0 } ],
      [ { "node": "4B. Initiate YouTube Upload (Manual)", "type": "main", "index": 0 } ]
    ]
  },
  "4A. Fetch Metadata from Sheets": {
    "main": [
      [ { "node": "5A. Initiate YouTube Upload (Sheets)", "type": "main", "index": 0 } ]
    ]
  },
  "5A. Initiate YouTube Upload (Sheets)": {
    "main": [
      [ { "node": "5B.1 Fetch Oldest Video from Drive (Sheets)", "type": "main", "index": 0 } ]
    ]
  },
  "5B.1 Fetch Oldest Video from Drive (Sheets)": {
    "main": [
      [ { "node": "5B.2 Download Video Binary (Sheets)", "type": "main", "index": 0 } ]
    ]
  },
  "5B.2 Download Video Binary (Sheets)": {
    "main": [
      [ { "node": "5B. Upload Binary (Sheets)", "type": "main", "index": 0 } ]
    ]
  },
  "5B. Upload Binary (Sheets)": {
    "main": [
      [ { "node": "6. Send Success Log to WebPilot", "type": "main", "index": 0 } ]
    ]
  },
  "4B. Initiate YouTube Upload (Manual)": {
    "main": [
      [ { "node": "4C.1 Fetch Oldest Video from Drive (Manual)", "type": "main", "index": 0 } ]
    ]
  },
  "4C.1 Fetch Oldest Video from Drive (Manual)": {
    "main": [
      [ { "node": "4C.2 Download Video Binary (Manual)", "type": "main", "index": 0 } ]
    ]
  },
  "4C.2 Download Video Binary (Manual)": {
    "main": [
      [ { "node": "4C. Upload Binary (Manual)", "type": "main", "index": 0 } ]
    ]
  },
  "4C. Upload Binary (Manual)": {
    "main": [
      [ { "node": "6. Send Success Log to WebPilot", "type": "main", "index": 0 } ]
    ]
  }
};

fs.writeFileSync(file, JSON.stringify(json, null, 2));
console.log('Restructured workflow successfully.');
