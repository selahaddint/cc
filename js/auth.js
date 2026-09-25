(() => {
  'use strict';

  const AUTH_STORAGE_KEY = 'co_access_v1';
  const AUTH_STORAGE_VALUE = '1';
  const USER_HASH = '946d5e40a25c40db4f7c370500e5e42ac5ae92b8798084adbc7b34284da94206';
  const PASS_HASH = '718d3d08c93f1cecd2ddce64d6d01b0c5015b31b53406abc0eb03785e2aefdc1';

  function sha256Fallback(ascii) {
    function rightRotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
    const maxWord = Math.pow(2, 32);
    let result = '';
    const words = [];
    const asciiBitLength = ascii.length * 8;
    let hash = sha256Fallback.h = sha256Fallback.h || [];
    const k = sha256Fallback.k = sha256Fallback.k || [];
    let primeCounter = k.length;
    const isComposite = {};

    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (Math.pow(candidate, .5) * maxWord) | 0;
        k[primeCounter++] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
      }
    }

    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (let i = 0; i < ascii.length; i++) {
      const j = ascii.charCodeAt(i);
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;

    for (let j = 0; j < words.length;) {
      const w = words.slice(j, j += 16);
      const oldHash = hash.slice(0);
      hash = hash.slice(0, 8);

      for (let i = 0; i < 64; i++) {
        const w15 = w[i - 15], w2 = w[i - 2];
        const a = hash[0], e = hash[4];
        const temp1 = hash[7]
          + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & hash[5]) ^ ((~e) & hash[6]))
          + k[i]
          + (w[i] = (i < 16) ? w[i] : (
            w[i - 16]
            + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
            + w[i - 7]
            + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
          ) | 0);
        const temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));

        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
        hash.pop();
      }

      for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }

    for (let i = 0; i < 8; i++) {
      for (let j = 3; j + 1; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += ((b < 16) ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  async function sha256(value) {
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      const data = new TextEncoder().encode(value);
      const digest = await window.crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }
    return sha256Fallback(unescape(encodeURIComponent(value)));
  }

  function unlock() {
    document.body.classList.remove('authLocked');
    const gate = document.getElementById('authGate');
    if (gate) gate.hidden = true;
  }

  try {
    if (localStorage.getItem(AUTH_STORAGE_KEY) === AUTH_STORAGE_VALUE) {
      unlock();
      return;
    }
  } catch (_) {}

  const form = document.getElementById('authForm');
  const user = document.getElementById('authUser');
  const pass = document.getElementById('authPass');
  const error = document.getElementById('authError');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    try {
      const [userHash, passHash] = await Promise.all([sha256(user.value), sha256(pass.value)]);
      if (userHash === USER_HASH && passHash === PASS_HASH) {
        try { localStorage.setItem(AUTH_STORAGE_KEY, AUTH_STORAGE_VALUE); } catch (_) {}
        pass.value = '';
        unlock();
      } else {
        error.textContent = 'Kullanıcı adı veya şifre hatalı.';
        pass.value = '';
        pass.focus();
      }
    } catch (_) {
      error.textContent = 'Giriş kontrolü çalıştırılamadı.';
    }
  });
})();
