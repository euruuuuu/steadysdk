import { describe, expect, it } from 'vitest';
import { applyCase, splitWords, toCase } from '../src/naming/case.js';

describe('splitWords', () => {
  it.each([
    ['getUserById', ['get', 'User', 'By', 'Id']],
    ['HTTPServer', ['HTTP', 'Server']],
    ['XMLHttpRequest', ['XML', 'Http', 'Request']],
    ['user-groups', ['user', 'groups']],
    ['get_user_by_id', ['get', 'user', 'by', 'id']],
    ['users.list', ['users', 'list']],
    ['listAPIs', ['list', 'APIs']],
    ['userIDs', ['user', 'IDs']],
    ['oauth2Token', ['oauth2', 'Token']],
    ['getV2Users', ['get', 'V2', 'Users']],
    ['X-Request-ID', ['X', 'Request', 'ID']],
    ['page[size]', ['page', 'size']],
    ['2fa', ['2fa']],
    ['', []],
  ])('%s', (input, words) => {
    expect(splitWords(input)).toEqual(words);
  });
});

describe('applyCase', () => {
  const words = ['get', 'user', 'by', 'id'];

  it.each([
    ['camel', 'getUserById'],
    ['pascal', 'GetUserById'],
    ['snake', 'get_user_by_id'],
    ['constant', 'GET_USER_BY_ID'],
  ] as const)('%s', (style, expected) => {
    expect(applyCase(words, style)).toBe(expected);
  });

  it('normalizes shouting words when no acronyms are configured', () => {
    expect(toCase('getHTTPServer', 'camel')).toBe('getHttpServer');
  });

  it('keeps configured acronyms, except where camelCase needs a lower-case start', () => {
    const options = { acronyms: ['ID', 'API', 'URL'] };
    expect(toCase('getUserById', 'camel', options)).toBe('getUserByID');
    expect(toCase('api_key', 'camel', options)).toBe('apiKey');
    expect(toCase('api_key', 'pascal', options)).toBe('APIKey');
    expect(toCase('list user ids', 'camel', options)).toBe('listUserIDs');
    expect(toCase('get_user_by_id', 'snake', options)).toBe('get_user_by_id');
  });

  it('re-joins mixed-case acronyms the splitter breaks apart', () => {
    expect(toCase('getOAuthToken', 'camel', { acronyms: ['OAuth'] })).toBe('getOAuthToken');
    expect(toCase('OAuthToken', 'camel', { acronyms: ['OAuth'] })).toBe('oauthToken');
  });

  it('preserve keeps the text and only replaces invalid characters', () => {
    expect(toCase('X-Request-ID', 'preserve')).toBe('X_Request_ID');
  });
});
