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

// Confirma que e a propria pessoa antes de algo serio (zerar tudo, trocar
// PIN): quem tem PIN digita o PIN; quem nao tem confirma o proprio telefone.
// PIN errado 5 vezes bloqueia por 15 minutos.
async function confirmarIdentidade(db, membroId, { pin, telefone }) {
  const r = await db.query(
    `SELECT telefone, pin_hash, pin_tentativas, pin_bloqueado_ate FROM membros WHERE id = $1`,
    [membroId]
  );
  const m = r.rows[0];
  if (!m) return { ok: false, status: 404, erro: 'Cadastro nao encontrado.' };

  if (m.pin_hash) {
    if (m.pin_bloqueado_ate && new Date(m.pin_bloqueado_ate) > new Date()) {
      return { ok: false, status: 429, erro: 'Muitas tentativas erradas. Espere 15 minutos.' };
    }
    if (!conferirPin(pin, m.pin_hash)) {
      const tentativas = (m.pin_tentativas || 0) + 1;
      if (tentativas >= 5) {
        await db.query(`UPDATE membros SET pin_tentativas = 0, pin_bloqueado_ate = NOW() + INTERVAL '15 minutes' WHERE id = $1`, [membroId]);
        return { ok: false, status: 429, erro: 'PIN errado 5 vezes. Espere 15 minutos.' };
      }
      await db.query(`UPDATE membros SET pin_tentativas = $1 WHERE id = $2`, [tentativas, membroId]);
      return { ok: false, status: 401, erro: `PIN errado. Você ainda tem ${5 - tentativas} tentativa(s).` };
    }
    await db.query(`UPDATE membros SET pin_tentativas = 0, pin_bloqueado_ate = NULL WHERE id = $1`, [membroId]);
    return { ok: true, tinhaPin: true };
  }

  const tel = String(telefone || '').replace(/\D/g, '');
  if (!tel || tel !== m.telefone) {
    return { ok: false, status: 401, erro: 'O telefone não confere com o do seu cadastro.' };
  }
  return { ok: true, tinhaPin: false };
}

module.exports = { gerarHashPin, conferirPin, pinValido, confirmarIdentidade };
