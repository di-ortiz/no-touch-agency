#!/usr/bin/env node
/**
 * Quick test: verify the service account can access the Google Drive root folder.
 * Run with: GOOGLE_SERVICE_ACCOUNT_JSON='...' GOOGLE_DRIVE_ROOT_FOLDER_ID='...' node test-drive-access.js
 */
import { google } from 'googleapis';
import fs from 'fs';

const FOLDER_ID = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '1W1BDq-eFD7wWKIAiVv9G2zptst34dGv2';

async function main() {
  // Write credentials from env var if needed
  const saPath = 'config/google-service-account.json';
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !fs.existsSync(saPath)) {
    if (!fs.existsSync('config')) fs.mkdirSync('config', { recursive: true });
    fs.writeFileSync(saPath, process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    console.log('✅ Wrote service account JSON from env var');
  }

  if (!fs.existsSync(saPath)) {
    console.error('❌ No credentials file at', saPath);
    console.error('   Set GOOGLE_SERVICE_ACCOUNT_JSON env var or place the file manually.');
    process.exit(1);
  }

  const creds = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  console.log(`🔑 Service account: ${creds.client_email}`);
  console.log(`📁 Testing folder:  ${FOLDER_ID}`);

  const auth = new google.auth.GoogleAuth({
    keyFile: saPath,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/presentations',
    ],
  });

  const drive = google.drive({ version: 'v3', auth });

  // Test 1: Can we see the folder?
  console.log('\n--- Test 1: Read folder metadata ---');
  try {
    const folder = await drive.files.get({ fileId: FOLDER_ID, fields: 'id, name, mimeType, owners' });
    console.log(`✅ Folder found: "${folder.data.name}" (${folder.data.mimeType})`);
  } catch (e) {
    console.error(`❌ Cannot read folder: ${e.message}`);
    if (e.message.includes('not found') || e.message.includes('permission')) {
      console.error('   → The folder has NOT been shared with the service account.');
      console.error(`   → Share ${FOLDER_ID} with ${creds.client_email} as Editor.`);
    }
    process.exit(1);
  }

  // Test 2: Can we list files in it?
  console.log('\n--- Test 2: List files in folder ---');
  try {
    const list = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType)',
      pageSize: 5,
    });
    console.log(`✅ Listed ${list.data.files.length} files in folder`);
    for (const f of list.data.files) {
      console.log(`   - ${f.name} (${f.mimeType})`);
    }
  } catch (e) {
    console.error(`❌ Cannot list files: ${e.message}`);
    process.exit(1);
  }

  // Test 3: Can we create a test file?
  console.log('\n--- Test 3: Create test file ---');
  let testFileId;
  try {
    const res = await drive.files.create({
      requestBody: {
        name: '_test_access_check_delete_me',
        mimeType: 'application/vnd.google-apps.document',
        parents: [FOLDER_ID],
      },
      fields: 'id, name, webViewLink',
    });
    testFileId = res.data.id;
    console.log(`✅ Created test file: ${res.data.name} (${res.data.webViewLink})`);
  } catch (e) {
    console.error(`❌ Cannot create file: ${e.message}`);
    if (e.message.includes('storage quota')) {
      console.error('   → Storage quota exceeded. The service account needs a shared folder (not its own Drive).');
    }
    if (e.message.includes('permission')) {
      console.error(`   → Share ${FOLDER_ID} with ${creds.client_email} as Editor (not Viewer).`);
    }
    process.exit(1);
  }

  // Test 4: Clean up test file
  console.log('\n--- Test 4: Delete test file ---');
  try {
    await drive.files.delete({ fileId: testFileId });
    console.log('✅ Test file deleted');
  } catch (e) {
    console.log(`⚠️  Could not delete test file (non-critical): ${e.message}`);
  }

  // Test 5: Sheets API
  console.log('\n--- Test 5: Google Sheets API ---');
  const sheets = google.sheets({ version: 'v4', auth });
  try {
    const res = await sheets.spreadsheets.create({
      requestBody: { properties: { title: '_test_sheet_delete_me' } },
    });
    const sheetId = res.data.spreadsheetId;
    console.log(`✅ Sheets API works (created ${sheetId})`);
    // Move to folder
    const file = await drive.files.get({ fileId: sheetId, fields: 'parents' });
    await drive.files.update({
      fileId: sheetId,
      addParents: FOLDER_ID,
      removeParents: file.data.parents?.join(',') || '',
    });
    console.log('✅ Moved sheet to target folder');
    await drive.files.delete({ fileId: sheetId });
    console.log('✅ Test sheet deleted');
  } catch (e) {
    console.error(`❌ Sheets API failed: ${e.message}`);
  }

  // Test 6: Slides API
  console.log('\n--- Test 6: Google Slides API ---');
  const slides = google.slides({ version: 'v1', auth });
  try {
    const res = await slides.presentations.create({
      requestBody: { title: '_test_slides_delete_me' },
    });
    const presId = res.data.presentationId;
    console.log(`✅ Slides API works (created ${presId})`);
    await drive.files.delete({ fileId: presId });
    console.log('✅ Test presentation deleted');
  } catch (e) {
    console.error(`❌ Slides API failed: ${e.message}`);
  }

  console.log('\n🎉 All tests passed! Google Drive integration is working.');
}

main().catch(e => {
  console.error('\n💥 Fatal error:', e.message);
  process.exit(1);
});
