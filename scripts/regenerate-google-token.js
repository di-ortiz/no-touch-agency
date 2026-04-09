#!/usr/bin/env node
/**
 * Regenerate Google OAuth2 refresh token for Sofia.
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx node scripts/regenerate-google-token.js
 *
 * This script:
 * 1. Prints an authorization URL — open it in your browser
 * 2. You sign in with Google and grant access
 * 3. Google redirects to localhost with an auth code
 * 4. Paste the full redirect URL (or just the code) back into the terminal
 * 5. The script exchanges it for a refresh token and prints it
 */

import { google } from 'googleapis';
import * as readline from 'readline';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌ Missing environment variables.');
  console.error('Run with:\n');
  console.error('  GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx node scripts/regenerate-google-token.js\n');
  process.exit(1);
}

// All scopes Sofia needs across all Google modules
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',      // Google Sheets
  'https://www.googleapis.com/auth/presentations',      // Google Slides
  'https://www.googleapis.com/auth/drive',              // Google Drive
  'https://www.googleapis.com/auth/documents',          // Google Docs
  'https://www.googleapis.com/auth/analytics.readonly', // Google Analytics (GA4)
  'https://www.googleapis.com/auth/webmasters.readonly',// Google Search Console
  'https://www.googleapis.com/auth/adwords',            // Google Ads
  'https://www.googleapis.com/auth/tagmanager.readonly', // Google Tag Manager (future)
];

const REDIRECT_URI = 'http://localhost:3333/oauth2callback';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',  // Force refresh token generation
  scope: SCOPES,
});

console.log('\n========================================');
console.log('  Google OAuth2 Token Regeneration');
console.log('========================================\n');
console.log('Step 1: Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nStep 2: Sign in with your Google account and grant all permissions.');
console.log('\nStep 3: After granting access, Google will redirect to a localhost URL.');
console.log('        It will fail to load (that\'s normal).');
console.log('        Copy the FULL URL from the browser address bar and paste it below.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the redirect URL (or just the code): ', async (input) => {
  rl.close();

  // Extract the authorization code from URL or raw code
  let code = input.trim();
  try {
    const url = new URL(code);
    code = url.searchParams.get('code') || code;
  } catch {
    // Not a URL — assume it's the raw code
  }

  if (!code) {
    console.error('\n❌ No authorization code found. Try again.');
    process.exit(1);
  }

  try {
    console.log('\nExchanging code for tokens...');
    const { tokens } = await oauth2Client.getToken(code);

    console.log('\n✅ SUCCESS! Here are your new tokens:\n');
    console.log('========================================');
    console.log('  REFRESH TOKEN (add to Railway):');
    console.log('========================================\n');
    console.log(tokens.refresh_token);
    console.log('\n========================================\n');

    if (tokens.access_token) {
      console.log('Access Token (temporary, expires):');
      console.log(tokens.access_token.slice(0, 50) + '...\n');
    }

    console.log('Scopes granted:', tokens.scope);
    console.log('\nNext steps:');
    console.log('1. Copy the REFRESH TOKEN above');
    console.log('2. Go to Railway → Variables');
    console.log('3. Update GOOGLE_REFRESH_TOKEN with the new value');
    console.log('4. If using Google Ads, also update GOOGLE_ADS_REFRESH_TOKEN');
    console.log('5. Railway will auto-redeploy\n');
  } catch (err) {
    console.error('\n❌ Token exchange failed:', err.message);
    if (err.response?.data) {
      console.error('Details:', JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }
});
