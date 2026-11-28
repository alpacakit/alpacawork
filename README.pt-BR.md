<p align="center">
  <a href="README.md">English</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <b>Português (Brasil)</b>
</p>

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/wordmark-dark.png">
    <img src="docs/images/wordmark.png" alt="alpacawork" width="380">
  </picture>
</h1>

<h3 align="center">Controle todos os seus agentes de IA em um só chat.</h3>

<p align="center">
  Faça um pedido. Os agentes de IA do seu PC, como o Claude Code e o Codex, o dividem em tarefas e as rodam em paralelo.<br/>
  Você responde às perguntas da IA e revisa os resultados. Também pelo celular.
</p>

<p align="center">
  <a href="#instalar"><b>Instalar</b></a> ·
  <a href="docs/pt-BR/getting-started.md">Primeiros passos</a> ·
  <a href="docs/pt-BR/concept.md">Como funciona</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/alpacawork"><img alt="npm" src="https://img.shields.io/npm/v/alpacawork?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark-pt-BR.gif">
    <img src="docs/images/hero-pt-BR.gif" alt="Um pedido escrito em um só campo chega ao coordenador, que cria tarefas em três projetos (site, app, marketing) e atribui a cada uma uma IA como opus · high ou gpt-5 · high; uma tarefa faz uma pergunta, você responde e todas terminam" width="640">
  </picture>
</p>

## O que é o alpacawork?

O alpacawork é uma ferramenta de orquestração de IA baseada em tarefas. Você coordena o Claude Code e o Codex que já usa em um único campo de chat.

É só fazer o pedido à IA que atende nesse chat, a coordenadora. Ela acompanha o andamento e repassa instruções às IAs que fazem o trabalho. Assim, você pode delegar tanto a divisão das tarefas quanto as instruções detalhadas.

<p align="center">
  <img src="docs/images/demo-dark-pt-BR.gif" alt="Um diagrama ao lado do aplicativo mostra um pedido virar três propostas que Claude e Codex preparam em paralelo. As mudanças passam pelo mesmo chat. Se uma IA atinge o limite de uso, outra retoma a partir do registro da tarefa. Conversas longas são compactadas ou reiniciadas. Você escolhe uma opção para responder, confere o resultado no celular e desliza para a direita para concluir." width="800">
</p>

### Sem trocar de chat

Use o mesmo campo de chat para fazer novos pedidos, acrescentar informações ou pedir mudanças no trabalho em andamento. A coordenadora transforma cada pedido em uma tarefa e a delega. Ela pode coordenar o trabalho em vários [projetos](docs/pt-BR/projects.md#criar-mais-projetos).

### Use o Claude Code e o Codex que você já tem

Comece no seu repositório habitual com os logins que você já usa. O alpacawork dispensa conta própria e chave de API. `AGENTS.md`, `CLAUDE.md`, skills, MCP e hooks funcionam como de costume. Também há suporte para GitHub Copilot, Grok Build e pi para modelos locais ([As IAs que você usa](docs/pt-BR/projects.md#as-ias-que-você-usa)).

### Roda no seu PC

Assim como o Claude Code e o Codex, o alpacawork roda no seu PC. As tarefas, as conversas e os arquivos de resultado ficam nele. O alpacawork não os envia a servidores externos de seus desenvolvedores ([Onde ficam os dados](docs/pt-BR/manage.md#onde-ficam-os-dados-e-o-que-é-enviado-para-fora)).

### Troque de IA e continue de onde parou

Se uma IA parar por erro ou limite de uso, você pode trocar para outra, por exemplo do Claude Code para o Codex, e continuar de onde o trabalho parou ([Tarefas paradas](docs/pt-BR/guide.md#tarefas-paradas)). Se você escolher uma [IA alternativa](docs/pt-BR/projects.md#escolher-o-modelo), ela assume automaticamente quando um limite de uso interrompe o trabalho.

### Quando a conversa fica longa, a IA abre uma nova

Estudos mostram que, quanto mais longa a conversa, maior a chance de a IA deixar passar instruções ou fazer suposições erradas ([Li et al. 2024](https://arxiv.org/abs/2402.10962), [Laban et al. 2025](https://arxiv.org/abs/2505.06120)). No alpacawork, a IA decide quando compactar a conversa ou abrir outra com os pontos principais do registro da tarefa.

### Descreva como trabalhar com suas palavras

Dê as instruções pelo chat, sem configuração complicada. Por exemplo: “Faça três propostas, cada uma com um modelo diferente. Junte as propostas e peça para outra IA revisar o resultado.” Você pode escolher os modelos e dizer como as IAs devem trabalhar juntas ([Diga como prosseguir com palavras](docs/pt-BR/concept.md#diga-como-prosseguir-com-palavras)).

### Faça o trabalho avançar pelo celular

Faça pedidos, responda a perguntas e confira os resultados pelo celular. Basta deslizar para agir sobre o que chegar ([Usar pelo celular](docs/pt-BR/remote.md#usar-pelo-celular)).

### Responda às perguntas escolhendo uma opção

Quando precisa de uma decisão sua, a IA envia uma pergunta com opções e uma recomendação. Ela pode anexar imagens da tela atualizada ou um vídeo de como funciona para facilitar a decisão.

### Tarefas, não conversas

Na tela ficam as tarefas que você pediu. As informações são organizadas por tarefa automaticamente, o que facilita o andamento do trabalho para você e para as IAs ([Como funciona](docs/pt-BR/concept.md#o-trabalho-avança-por-tarefas-não-por-conversas)).

## Instalar

Cole o texto abaixo no Claude Code ou no Codex do seu PC. A IA instala o alpacawork e informa a URL da tela de configuração inicial, que normalmente também abre no navegador.

```text
Baixe o guia abaixo, leia-o inteiro e siga as instruções para instalar o alpacawork neste PC.
https://raw.githubusercontent.com/alpacakit/alpacawork/main/skills/alpacawork/references/setup.md
```

Para instalar pela linha de comando, execute estas duas linhas no terminal (no Windows, dentro do Ubuntu), nesta ordem. A configuração inicial mostra o que vai preparar e começa quando você pressiona Enter.

```sh
npm install -g alpacawork
alpacawork setup
```

Os requisitos são macOS (Apple silicon), Linux (x64) ou Windows (WSL2). Depois de instalar, siga os [Primeiros passos](docs/pt-BR/getting-started.md) para fazer a sua primeira solicitação.

### Abrir a tela

Para abrir a tela no navegador, peça assim no Claude Code ou no Codex (`$alpacawork` no Codex).

```text
/alpacawork abra a tela
```

No terminal, `alpacawork open` também abre a tela.

## Vale saber

- **É gratuito (licença MIT).** O uso de IA é cobrado de acordo com o plano que você já tem do Claude Code, do Codex ou de outro agente.
- **Roda no seu PC.** Mantenha o PC ligado e configure-o para não entrar em suspensão enquanto você usa o alpacawork.
- **O alpacawork inicia os agentes de IA no mesmo modo sem confirmações que o `bypassPermissions` do Claude Code e o `danger-full-access` do Codex, então eles não param para perguntar.** Você pode escrever na [política do projeto](docs/pt-BR/projects.md#política-do-projeto) o que a IA não deve fazer, ou o que deve perguntar a você antes.
- **Tarefas, conversas e arquivos de resultado ficam no seu PC.** O alpacawork não os envia a nenhum servidor externo mantido pelos desenvolvedores. Suas instruções para a IA e o conteúdo que ela lê são enviados ao provedor da IA, como acontece quando você usa cada agente de IA diretamente ([mais sobre o tratamento dos dados](docs/pt-BR/manage.md#onde-ficam-os-dados-e-o-que-é-enviado-para-fora)).

## Documentação

- [Primeiros passos](docs/pt-BR/getting-started.md) — instalar, fazer uma solicitação e revisar o resultado
- [Início da documentação](docs/pt-BR/README.md) — como usar, configurações, solução de problemas e a lista de todas as páginas
- Reporte bugs nas [Issues](https://github.com/alpacakit/alpacawork/issues)
- Os anúncios de novas versões são publicados no X: [@codemafia0000](https://x.com/codemafia0000)

## Licença

[Licença MIT](LICENSE)
