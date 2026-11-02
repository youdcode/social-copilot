import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { accountIdFromToken, oauth1Header, percentEncode, signatureBaseString } from '../src/x/oauth1.ts';

// The worked example of X's "Creating a signature" guide.
const url = 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true';
const credentials = {
  consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
  consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
  token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
  tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
};
const options = {
  bodyParams: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
  nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
  timestamp: 1318622958,
};

describe('OAuth 1.0a', () => {
  test('percent-encodes as RFC 3986 asks', () => {
    assert.equal(percentEncode("Ladies + Gentlemen!*'()"), 'Ladies%20%2B%20Gentlemen%21%2A%27%28%29');
  });

  test('builds the signature base string of the guide', () => {
    const oauth: Array<[string, string]> = [
      ['oauth_consumer_key', credentials.consumerKey],
      ['oauth_nonce', options.nonce],
      ['oauth_signature_method', 'HMAC-SHA1'],
      ['oauth_timestamp', String(options.timestamp)],
      ['oauth_token', credentials.token],
      ['oauth_version', '1.0'],
    ];
    assert.equal(
      signatureBaseString('POST', url, [['status', options.bodyParams.status], ...oauth]),
      'POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521',
    );
  });

  test('signs like the guide', () => {
    const header = oauth1Header('POST', url, credentials, options);
    assert.match(header, /^OAuth /);
    assert.match(header, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
    assert.match(header, /oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb"/);
  });

  test('reads the account id at the start of an access token', () => {
    assert.equal(accountIdFromToken('370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb'), '370773112');
    assert.equal(accountIdFromToken('no-id-here'), undefined);
  });
});
