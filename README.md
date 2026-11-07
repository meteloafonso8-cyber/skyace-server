# Sky Ace – servidor (ranking global + multijogador)

Dois ficheiros (`server.js` + `filter.js`, o filtro de nomes), **sem dependências**. Só precisa de Node.js 18+.

## Testar no teu PC
```bash
cd server
node server.js          # fica a ouvir na porta 8080
node test.js            # corre 20 testes automáticos
node test-upstash.js    # testa o ranking permanente (com um Upstash simulado)
```
Para ligar a extensão a este servidor, em `extension/config.js` põe:
`SERVER: 'http://localhost:8080'` e carrega a extensão em `chrome://extensions` (Modo de programador → Carregar sem compactação → pasta `extension`).
Para testar o multijogador sozinho, abre o jogo em dois perfis do Chrome (ou um perfil + janela anónima com a extensão permitida).

## Pôr online (necessário para o ranking e salas funcionarem para toda a gente)
Precisas de um sítio que corra Node 24 h/dia e dê **HTTPS/WSS** (a Chrome Web Store e o Chrome esperam ligações seguras).
Opções comuns: **Render**, **Railway**, **Fly.io**, ou um VPS próprio com Caddy/Nginx. Os planos gratuitos mudam com frequência – confirma no site deles.

### Exemplo: Render
1. Põe a pasta `server/` num repositório GitHub.
2. Render → New → Web Service → escolhe o repositório. Runtime Node, Build: *(vazio)*, Start: `node server.js`.
3. Variáveis de ambiente: `TRUST_PROXY=1` e `ADMIN_KEY=<uma-chave-grande-e-secreta>`.
4. Quando estiver online, abre `https://O-TEU-SERVIDOR/health` → deve mostrar `{"ok":true,...}`.
5. Copia esse endereço para `extension/config.js` (`SERVER`).

### Ranking permanente e grátis: Upstash Redis (recomendado)
Nos planos gratuitos do Render o disco é apagado quando o servidor reinicia ou adormece, por isso o ranking em ficheiro perder-se-ia. Solução: guardar o ranking no **Upstash** (Redis gratuito, acessível por HTTP).
1. Cria conta em **upstash.com** → **Create Database** (tipo Redis; região **Europa**, ex. Frankfurt ou Ireland).
2. Na página da base de dados, secção **REST API**, copia o **UPSTASH_REDIS_REST_URL** e o **UPSTASH_REDIS_REST_TOKEN**.
3. No Render → o teu serviço → **Environment** → adiciona essas duas variáveis → Save (o servidor reinicia).
4. Confirma em `https://O-TEU-SERVIDOR/health`: deve dizer `"storage":"upstash"`. Nos *Logs* aparece "Ranking carregado do Upstash".
Se não configurares o Upstash, o servidor usa um ficheiro local (`DATA_DIR/scores.json`), que só é permanente em discos persistentes/VPS.

### Manter o servidor acordado (opcional, melhora o multijogador)
No plano gratuito o Render adormece o servidor após 15 minutos sem tráfego e demora ~1 min a acordar. O jogo já o acorda sozinho ao abrir (mostra "A acordar o servidor…"), mas podes evitar a espera com um monitor gratuito (ex.: UptimeRobot) a abrir `https://O-TEU-SERVIDOR/health` de 5 em 5 minutos.

## Variáveis de ambiente
| Variável | Para quê |
|---|---|
| `PORT` | Porta (por omissão 8080; a maioria das plataformas define-a sozinha) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Ranking permanente no Upstash (ver acima) |
| `DATA_DIR` | Pasta do `scores.json` (só quando não há Upstash) |
| `TRUST_PROXY=1` | **Obrigatório atrás de Render/Fly/Nginx** (para ler o IP real nos limites de pedidos) |
| `ADMIN_KEY` | Chave para moderação (ver abaixo) |
| `ALLOWED_EXTENSION_ID` | Depois de publicares, põe aqui o ID da extensão: só ela poderá usar o servidor |

## Moderação (apagar nomes impróprios do ranking)
```bash
curl -X POST https://O-TEU-SERVIDOR/api/admin/delete \
  -H "X-Admin-Key: A_TUA_CHAVE" -H "Content-Type: application/json" \
  -d '{"name":"NomeImproprio"}'
```

## Nomes e abates (v2.1)
- Cada jogador reserva um nome **único** (ignora maiúsculas, espaços, `.`, `_` e `-`, para ninguém se fazer passar por outro). Nomes impróprios (PT/EN/ES/FR/DE, com truques como `f.u.c.k` ou `sh1t`) são recusados; se algum já estiver guardado, é **apagado automaticamente** (passa a `Anon####`) quando o servidor arranca.
- O servidor soma os **abates totais** de cada jogador e tem um ranking próprio (`/api/top?board=kills`).
- O filtro é básico: não apanha tudo. Para casos que passem, usa a moderação abaixo (apaga também a reserva do nome).
- Importante: quando atualizas o servidor, mete **também o `filter.js`** no GitHub.

## O que o servidor faz e não faz
- Ranking: guarda por jogador (ID aleatório) a melhor pontuação, com nome limpo (2–12 caracteres). Rejeita pontuações impossíveis (limite por segundo jogado) e limita pedidos por IP.
- Salas: códigos de 5 caracteres, até 4 jogadores, partidas de 2 min. O servidor só **reencaminha** posições/pontos; não simula o jogo.
- **Limite honesto:** como o jogo corre no browser, um utilizador técnico consegue sempre forjar pontuações dentro do limite plausível. O filtro trava batota óbvia, não é à prova de batota. Usa a moderação acima quando necessário.
