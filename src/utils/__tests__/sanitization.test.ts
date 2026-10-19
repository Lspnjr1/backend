import { describe, expect, it } from 'vitest';
import {
  sanitizeText,
  stripHtml,
  truncate,
  TEXT_LIMITS,
} from '../sanitization';

describe('sanitization (XSS / HTML stripping)', () => {
  it('strips script tags and leaves inner text', () => {
    expect(stripHtml('<script>alert(1)</script>')).toBe('alert(1)');
  });

  it('strips inline event handlers', () => {
    expect(stripHtml('<img src=x onerror=alert(1)>')).toBe('');
    expect(stripHtml('<svg onload=alert(1)>')).toBe('');
    expect(stripHtml('<body onload=alert(1)>hi</body>')).toBe('hi');
  });

  it('strips dangerous URL schemes', () => {
    expect(stripHtml('javascript:alert(1)')).toBe('alert(1)');
    expect(stripHtml('vbscript:msgbox(1)')).toBe('msgbox(1)');
    expect(stripHtml('data:text/html,<script>alert(1)</script>')).toBe(
      'text/html,alert(1)',
    );
  });

  it('strips a mix of tags, entities and attributes', () => {
    expect(
      stripHtml('<a href="javascript:alert(1)" onclick="alert(1)">click</a>'),
    ).toBe('click');
    expect(stripHtml('<b>bold</b> <i>italic</i>')).toBe('bold italic');
  });

  it('removes control characters', () => {
    expect(stripHtml('hello\u0000world\u001f')).toBe('helloworld');
  });

  it('trims surrounding whitespace', () => {
    expect(stripHtml('   hello   ')).toBe('hello');
  });

  it('handles non-string input gracefully', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
    expect(stripHtml(42)).toBe('42');
  });
});

describe('sanitizeText', () => {
  const xssPayloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    'javascript:alert(1)',
    '<svg onload=alert(1)>',
    '<iframe src="javascript:alert(1)">',
    '<body onload=alert(1)>xss</body>',
    '<div style="background:url(javascript:alert(1))">x</div>',
  ];

  it('converts every XSS payload to plain text with no HTML remaining', () => {
    for (const payload of xssPayloads) {
      const cleaned = sanitizeText(payload);
      expect(cleaned).not.toMatch(/</);
      expect(cleaned).not.toMatch(/>/);
      expect(cleaned).not.toMatch(/(javascript|vbscript|data)\s*:/i);
      expect(cleaned).not.toMatch(/\bon\w+\s*=/i);
    }
  });

  it('truncates to the documented maximum length', () => {
    const long = 'a'.repeat(1000);
    expect(sanitizeText(long, { maxLength: TEXT_LIMITS.BIO }).length).toBe(
      TEXT_LIMITS.BIO,
    );
    expect(sanitizeText('short', { maxLength: TEXT_LIMITS.BIO })).toBe('short');
  });

  it('collapses whitespace when requested', () => {
    expect(sanitizeText('a   b\n\nc', { collapseWhitespace: true })).toBe(
      'a b c',
    );
  });
});

describe('truncate', () => {
  it('slices at maxLength', () => {
    expect(truncate('hello world', 5)).toBe('hello');
    expect(truncate('hi', 100)).toBe('hi');
  });
});

describe('TEXT_LIMITS', () => {
  it('documents maximum lengths for all user-provided text fields', () => {
    expect(TEXT_LIMITS.TIP_MESSAGE).toBe(500);
    expect(TEXT_LIMITS.BIO).toBe(500);
    expect(TEXT_LIMITS.TEAM_NAME).toBe(60);
    expect(TEXT_LIMITS.TEAM_DESCRIPTION).toBe(280);
  });
});
