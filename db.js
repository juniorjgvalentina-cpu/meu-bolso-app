const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

// Todo o sistema trabalha no horario de Brasilia (o servidor do Railway roda
// em UTC). Sem isso, um gasto lancado depois das 21h do ultimo dia do mes
// caia no mes seguinte, e uma compra no cartao depois das 21h do dia do
// fechamento ia pra fatura errada.
pool.on('connect', (client) => {
  client.query(`SET TIME ZONE 'America/Sao_Paulo'`).catch(err => {
    console.error('Erro ao ajustar fuso horario da conexao:', err);
  });
});

pool.on('error', (err) => {
  console.error('Erro inesperado no pool do PostgreSQL:', err);
});

module.exports = pool;
