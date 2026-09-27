// Situação da revisão no Bitbucket (Cloud e Server) e no Azure DevOps. Uso: node test/reviewPlatforms.test.js
const assert = require('assert');
const { bitbucketCloudReview, bitbucketServerReview, azureReview } = require('../out/hosting/core');
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.stack || e}`);
  }
};
check('Bitbucket Cloud: aprovado, mudanças pedidas e aguardando', () => {
  const u = n => ({ nickname: n });
  assert.deepStrictEqual(bitbucketCloudReview([{ role: 'REVIEWER', approved: true, user: u('ana') }]), { state: 'approved', approvals: 1, by: ['ana'] });
  assert.strictEqual(bitbucketCloudReview([{ role: 'REVIEWER', approved: true, user: u('ana') }, { role: 'REVIEWER', state: 'changes_requested', user: u('bia') }]).state, 'changes');
  assert.strictEqual(bitbucketCloudReview([{ role: 'REVIEWER', approved: false, user: u('ana') }]).state, 'pending');
});
check('Bitbucket Server: APPROVED / NEEDS_WORK / UNAPPROVED', () => {
  assert.strictEqual(bitbucketServerReview([{ status: 'APPROVED', user: { name: 'a' } }]).state, 'approved');
  assert.strictEqual(bitbucketServerReview([{ status: 'APPROVED' }, { status: 'NEEDS_WORK', user: { name: 'b' } }]).state, 'changes');
  assert.strictEqual(bitbucketServerReview([{ status: 'UNAPPROVED' }]).state, 'pending');
});
check('Azure DevOps: votos 10/5 aprovam, -5/-10 pedem mudança, 0 aguarda', () => {
  assert.deepStrictEqual(azureReview([{ vote: 10, displayName: 'Ana' }, { vote: 5, displayName: 'Bia' }]), { state: 'approved', approvals: 2, by: ['Ana', 'Bia'] });
  assert.strictEqual(azureReview([{ vote: 10 }, { vote: -5, displayName: 'Rui' }]).state, 'changes');
  assert.strictEqual(azureReview([{ vote: -10 }]).state, 'changes');
  assert.strictEqual(azureReview([{ vote: 0 }]).state, 'pending');
});
if (failures) process.exit(1);
