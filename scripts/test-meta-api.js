import 'dotenv/config';
import { getAdAccounts, getBusinessInfo } from '../src/api/meta-ads.js';

console.log('Testing Meta API connection...\n');

try {
  console.log('1. Fetching business info...');
  const biz = await getBusinessInfo();
  if (biz) {
    console.log('   Business:', JSON.stringify(biz, null, 2));
  } else {
    console.log('   No business info returned');
  }

  console.log('\n2. Fetching ad accounts...');
  const accounts = await getAdAccounts();
  if (accounts?.data?.length) {
    console.log(`   Found ${accounts.data.length} ad account(s):`);
    for (const acc of accounts.data) {
      console.log(`   - ${acc.name} (${acc.account_id}) [${acc.account_status === 1 ? 'ACTIVE' : 'status:' + acc.account_status}] ${acc.currency}`);
    }
  } else {
    console.log('   No ad accounts found. Response:', JSON.stringify(accounts, null, 2));
  }

  console.log('\nMeta API connection successful!');
} catch (err) {
  console.error('\nMeta API connection FAILED:');
  if (err.response) {
    console.error('  Status:', err.response.status);
    console.error('  Error:', JSON.stringify(err.response.data?.error || err.response.data, null, 2));
  } else {
    console.error(' ', err.message);
  }
  process.exit(1);
}
