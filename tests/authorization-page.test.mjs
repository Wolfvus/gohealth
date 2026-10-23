import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationPage } from '../dist/authorization-page.js';

test('authorization pages distinguish an ongoing export from completion', () => {
  const html = authorizationPage('exporting');
  assert.match(html, /Your export is running/);
  assert.match(html, /Keep the terminal open/);
  assert.match(html, /When the terminal confirms “Export saved”/);
  assert.match(html, /goh start<br>goh open/);
});

test('all authorization states render accessible, self-contained pages', () => {
  for (const stage of ['connect', 'exporting', 'invalid', 'failed']) {
    const html = authorizationPage(stage);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<main>/);
    assert.match(html, /<h1>/);
    assert.match(html, /name="viewport"/);
    assert.doesNotMatch(html, /<script|https?:\/\//);
  }
  assert.match(authorizationPage('invalid'), /goh auth/);
  assert.match(authorizationPage('failed'), /Check the error in your terminal/);
  assert.match(authorizationPage('failed'), /Ctrl\+C to stop the previous command/);
});
