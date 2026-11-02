const { scryptSync, randomBytes, timingSafeEqual } = require('crypto');

// PIN de 4 digitos guardado com hash (nunca o numero puro no banco).
function gerarHashPin(pin) {
  const sal = randomBytes(16).toString('hex');
  const hash = scryptSync(String(pin), sal, 32).toString('hex');
  return `scrypt$${sal}$${hash}`;
}

function conferirPin(pin, guardado) {
  if (!guardado || !pin) return false;
  const [, sal, hash] = String(guardado).split('$');
  if (!sal || !hash) return false;
  const tentativa = scryptSync(String(pin), sal, 32);
  const certo = Buffer.from(hash, 'hex');
  return tentativa.length === certo.length && timingSafeEqual(tentativa, certo);
}

function pinValido(pin) {
  return /^\d{4}$/.test(String(pin || ''));
}

module.exports = { gerarHashPin, conferirPin, pinValido };
