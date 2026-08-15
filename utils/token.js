const { randomUUID } = require('crypto');

// Gera um token de acesso unico e longo o suficiente pra nao ser adivinhado.
// Usado tanto no cadastro inicial quanto toda vez que um membro novo
// entra numa conta compartilhada (casal/familia).
function gerarToken() {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 16);
}

module.exports = { gerarToken };
