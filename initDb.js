const pool = require('./db');

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Contas: a entidade que paga a assinatura (individual/casal/familia)
    await client.query(`
      CREATE TABLE IF NOT EXISTS contas (
        id SERIAL PRIMARY KEY,
        plano VARCHAR(20) NOT NULL DEFAULT 'individual',
        valor_plano NUMERIC(6,2) NOT NULL DEFAULT 12.99,
        limite_membros INTEGER NOT NULL DEFAULT 1,
        status_assinatura VARCHAR(20) NOT NULL DEFAULT 'teste',
        data_cadastro TIMESTAMP NOT NULL DEFAULT NOW(),
        data_vencimento TIMESTAMP,
        ultima_cobranca TIMESTAMP
      );
    `);

    // Membros: cada pessoa com login proprio dentro de uma conta
    await client.query(`
      CREATE TABLE IF NOT EXISTS membros (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        nome VARCHAR(120) NOT NULL,
        telefone VARCHAR(20) NOT NULL,
        token_acesso VARCHAR(64) NOT NULL UNIQUE,
        papel VARCHAR(10) NOT NULL DEFAULT 'dono',
        data_entrada TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (conta_id, telefone)
      );
    `);

    // Itens conhecidos: o "dicionario inteligente" por conta
    await client.query(`
      CREATE TABLE IF NOT EXISTS itens_conhecidos (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        nome_item VARCHAR(120) NOT NULL,
        nome_item_normalizado VARCHAR(120) NOT NULL,
        tipo VARCHAR(15) NOT NULL,
        data_criacao TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (conta_id, nome_item_normalizado)
      );
    `);

    // Lancamentos
    await client.query(`
      CREATE TABLE IF NOT EXISTS lancamentos (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        membro_id INTEGER NOT NULL REFERENCES membros(id) ON DELETE CASCADE,
        descricao VARCHAR(120) NOT NULL,
        valor NUMERIC(10,2) NOT NULL,
        tipo_movimento VARCHAR(10) NOT NULL,
        categoria VARCHAR(15),
        forma_pagamento VARCHAR(10),
        parcela_atual INTEGER,
        total_parcelas INTEGER,
        grupo_parcela_id UUID,
        data_lancamento TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Metas de economia
    await client.query(`
      CREATE TABLE IF NOT EXISTS metas (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        valor_meta_economia NUMERIC(10,2) NOT NULL,
        mes_referencia VARCHAR(7) NOT NULL,
        UNIQUE (conta_id, mes_referencia)
      );
    `);

    // Orcamentos por categoria
    await client.query(`
      CREATE TABLE IF NOT EXISTS orcamentos (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        categoria VARCHAR(15) NOT NULL,
        valor_teto NUMERIC(10,2) NOT NULL,
        mes_referencia VARCHAR(7) NOT NULL,
        UNIQUE (conta_id, categoria, mes_referencia)
      );
    `);

    // Contas pendentes: "A Pagar / A Receber" da tela de Planilha.
    // Valor e opcional (a pessoa pode nao saber o valor exato ainda).
    // Quando resolvida, vira um lancamento real (linkado por lancamento_id).
    await client.query(`
      CREATE TABLE IF NOT EXISTS contas_pendentes (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        membro_id INTEGER REFERENCES membros(id) ON DELETE SET NULL,
        tipo VARCHAR(10) NOT NULL,
        nome VARCHAR(120) NOT NULL,
        valor NUMERIC(10,2),
        data_vencimento DATE NOT NULL,
        resolvido BOOLEAN NOT NULL DEFAULT FALSE,
        data_resolucao TIMESTAMP,
        lancamento_id INTEGER REFERENCES lancamentos(id) ON DELETE SET NULL,
        data_criacao TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query('COMMIT');
    console.log('initDb: tabelas verificadas/criadas com sucesso.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('initDb: erro ao criar tabelas:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = initDb;
