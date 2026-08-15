// Remove acentos, deixa minusculo e tira espaco extra.
// Resolve o bug classico de "não" vs "nao" nao serem reconhecidos como iguais.
function normalizarTexto(texto) {
  if (!texto) return '';
  return texto
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

// Distancia de Levenshtein: mede quantas letras precisam mudar
// pra uma palavra virar a outra. Usado pra pegar erro de digitacao
// tipo "piza" vs "pizza" sem confundir palavras realmente diferentes.
function distanciaLevenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + custo
      );
    }
  }
  return dp[m][n];
}

// Retorna um valor de 0 a 1 (1 = identico) de quao parecidas sao duas strings.
function similaridade(a, b) {
  const na = normalizarTexto(a);
  const nb = normalizarTexto(b);
  if (na === nb) return 1;
  const maiorTamanho = Math.max(na.length, nb.length);
  if (maiorTamanho === 0) return 1;
  const distancia = distanciaLevenshtein(na, nb);
  return 1 - distancia / maiorTamanho;
}

module.exports = { normalizarTexto, distanciaLevenshtein, similaridade };
