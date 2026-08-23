const express = require('express');
const router = express.Router();
const pool = require('../db');
const autenticar = require('../middleware/autenticar');

// Calcula a proxima data em que o dia de vencimento acontece - se o dia ja
// passou nesse mes, usa o mes seguinte. Mesma logica usada no "fixar
// vencimento" do dicionario em Configuracoes.
function calcularProximoVencimentoDia(dia) {
  const hoje = new Date();
  let ano = hoje.getFullYear();
  let mes = hoje.getMonth();
  if (dia < hoje.getDate()) {
    mes += 1;
    if (mes > 11) { mes = 0; ano += 1; }
  }
  const ultimoDiaDoMes = new Date(ano, mes + 1, 0).getDate();
  const diaFinal = Math.min(dia, ultimoDiaDoMes);
  return `${ano}-${String(mes + 1).padStart(2, '0')}-${String(diaFinal).padStart(2, '0')}`;
}

// Lista os cartoes da conta.
router.get('/cartoes', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM cartoes WHERE conta_id = $1 ORDER BY nome ASC`,
      [req.conta.id]
    );
    res.json({ cartoes: result.rows });
  } catch (err) {
    console.error('Erro ao listar cartoes:', err);
    res.status(500).json({ erro: 'Erro ao buscar cartoes.' });
  }
});

// Cria um cartao novo - ja cria junto a pendencia recorrente "Fatura do
// cartao [nome]" pro dia de vencimento escolhido, igual uma conta fixa
// (aluguel etc). Assim a pessoa nao precisa cadastrar separado.
router.post('/cartoes', autenticar, async (req, res) => {
  const { nome, dia_vencimento } = req.body;

  if (!nome || !nome.trim()) {
    return res.status(400).json({ erro: 'Nome do cartao e obrigatorio.' });
  }
  const dia = parseInt(dia_vencimento, 10);
  if (!dia || dia < 1 || dia > 31) {
    return res.status(400).json({ erro: 'Dia de vencimento invalido.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cartaoResult = await client.query(
      `INSERT INTO cartoes (conta_id, nome, dia_vencimento) VALUES ($1, $2, $3) RETURNING *`,
      [req.conta.id, nome.trim(), dia]
    );
    const cartao = cartaoResult.rows[0];

    await client.query(
      `INSERT INTO contas_pendentes (conta_id, membro_id, tipo, nome, data_vencimento, recorrente, cartao_id)
       VALUES ($1, $2, 'pagar', $3, $4, TRUE, $5)`,
      [req.conta.id, req.membro.id, `Fatura do cartão ${cartao.nome}`, calcularProximoVencimentoDia(dia), cartao.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ cartao });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar cartao:', err);
    res.status(500).json({ erro: 'Erro ao criar cartao.' });
  } finally {
    client.release();
  }
});

// Exclui um cartao. Os lancamentos ja feitos com ele continuam existindo
// (so perdem o vinculo), e a pendencia recorrente da fatura dele some junto.
router.delete('/cartoes/:id', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM cartoes WHERE id = $1 AND conta_id = $2 RETURNING id`,
      [req.params.id, req.conta.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Cartao nao encontrado.' });
    }
    res.json({ status: 'ok', excluido: result.rows[0].id });
  } catch (err) {
    console.error('Erro ao excluir cartao:', err);
    res.status(500).json({ erro: 'Erro ao excluir cartao.' });
  }
});

module.exports = router;
