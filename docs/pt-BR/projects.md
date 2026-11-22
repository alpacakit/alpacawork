# Adaptar ao seu trabalho

Como definir os projetos, a política do projeto e as IAs que você usa. Todas as configurações desta página a IA muda se você pedir no campo de mensagem (só o login nas IAs e as chaves de API você faz por conta própria).

## Usar em um repositório existente

Escolha a pasta do repositório como “Local do código” do projeto. Não é preciso mover nada. A IA também lê, como sempre, o `AGENTS.md` e o `CLAUDE.md` da pasta.

Para mudar depois: nome do projeto, no canto superior esquerdo da tela → “Configurações de (nome do projeto)…” → “Escolher” em “Local do código” → “Salvar”.

A IA altera arquivos sem pedir confirmação. Se você fizer um commit antes de começar, vai conseguir distinguir e desfazer as mudanças da IA.

## Criar mais projetos

Crie um projeto para cada repositório. Em nome do projeto, no canto superior esquerdo → “Novo projeto”, informe o nome e o local do código e pressione “Criar”.

Um projeto que você não usa mais pode ser arquivado no final das configurações do projeto.

## Política do projeto

Escreva em frases simples, em “Política do projeto” nas configurações do projeto, o que a IA pode decidir sozinha, o que ela deve perguntar antes e o que ela não deve fazer. Isso chega a todas as IAs do projeto.

O uso é basicamente o mesmo do `AGENTS.md`. Escreva na política do projeto as instruções que você quer que a IA leia só quando usa o alpacawork.

```text
Objetivo: deixar o site da loja fácil de ver no celular e publicá-lo
Como fazer: para mudanças na aparência, mostre uma prévia e pergunte antes de criar
O que você decide: a forma de trabalhar, os testes e a arrumação; decida sem perguntar e me relate
O que não fazer: não faça push para o GitHub nem publique sem aprovação
```

A política é um combinado com a IA, não um mecanismo que a impede. Para limitar o que a IA alcança, use um PC ou um usuário do sistema operacional separado para o trabalho.

## As IAs que você usa

| Agente de IA | O que ele exige |
| --- | --- |
| Claude Code, Codex | Login pela própria CLI |
| GitHub Copilot | Login na GitHub CLI (`gh auth login`). O agente vem junto |
| Grok Build, pi | Login ou uma chave de API |

Para escolher as IAs que vai usar, ative-as em “Agentes”, em “Configurações (engrenagem) → Servidor”, e pressione “Salvar”. Para dividir o trabalho entre elas, escreva isso na política (“Implementação com o Codex, verificação com o Claude Code”).

Os planos e as configurações das IAs continuam os que você já tem. A cobrança também segue os seus planos.

## Escolher o modelo

O modelo que você escolhe ao lado do campo de mensagem é o da IA que é seu ponto de contato. O modelo das IAs responsáveis você escreve na solicitação ou na política (“Faça este trabalho com o opus”).

Para adicionar um modelo novo, abra o cartão da IA em “Agentes”, em “Configurações (engrenagem) → Servidor”, acrescente o nome do modelo na linha `model` de “Valores disponíveis ao solicitar trabalho” e pressione “Salvar”.

## Passar uma chave de API

Não escreva a chave no campo de mensagem nem na tela; escreva-a você mesmo em um arquivo.

1. Veja o local em “Arquivo de ambiente”, no final de “Configurações (engrenagem) → Servidor” (normalmente `~/.config/alpacawork/env`).
2. Escreva uma por linha, como `ANTHROPIC_API_KEY=...`, e impeça que outros usuários leiam o arquivo: `chmod 600 ~/.config/alpacawork/env`
3. Reinicie o alpacawork ([Parar e iniciar](manage.md#parar-e-iniciar)).
4. Confira se o nome está em “Variáveis de ambiente adicionais”, no cartão da IA. Se não estiver, acrescente e pressione “Salvar”.

## Quantas rodam ao mesmo tempo

No início, até 8 IAs rodam ao mesmo tempo. Se isso gastar demais os seus limites de uso, diminua “Máx. de execuções simultâneas” em “Configurações (engrenagem) → Servidor” → “Opções avançadas” e pressione “Salvar”.
