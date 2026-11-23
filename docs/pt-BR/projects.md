# Adaptar ao seu trabalho

Como definir os projetos, a política do projeto e as IAs que você usa. A IA muda qualquer configuração desta página se você pedir no campo de mensagem (só o login nas IAs e as chaves de API você faz por conta própria).

## Usar em um repositório existente

Escolha a pasta do repositório como “Pasta de trabalho” do projeto. Não é preciso mover nada. A IA também lê, como sempre, o `AGENTS.md` e o `CLAUDE.md` da pasta.

Para mudar depois: nome do projeto, no canto superior esquerdo da tela → “(nome do projeto) – configurações…” → “Escolher” em “Pasta de trabalho” → “Salvar”.

A IA altera arquivos sem pedir confirmação. Se você fizer um commit antes de começar, vai conseguir distinguir e desfazer as mudanças da IA.

## Criar mais projetos

Crie um projeto para cada repositório. Pressione o nome do projeto, no canto superior esquerdo → “Novo projeto”, informe o nome e a pasta de trabalho e pressione “Criar”.

Cada projeto tem um “Resumo”, uma frase que diz para que ele serve. A IA o lê para escolher o projeto de uma solicitação que não diz a qual pertence, e todas as IAs que trabalham no projeto o recebem. Enquanto o resumo estiver vazio, a IA o escreve na próxima vez que coloca uma solicitação no projeto. Você pode alterá-lo nas configurações do projeto.

Um projeto que você não usa mais pode ser arquivado no final das configurações do projeto.

## Política do projeto

Escreva em frases simples, em “Política do projeto” nas configurações do projeto, o que a IA pode decidir sozinha, o que ela deve perguntar antes e o que ela não deve fazer. Isso chega a todas as IAs do projeto.

O uso é basicamente o mesmo do `AGENTS.md`. Escreva na política do projeto as instruções que você quer que a IA leia só quando usa o alpacawork.

```text
Como fazer: para mudanças na aparência, mostre uma prévia e pergunte antes de criar
O que você decide: a forma de trabalhar, os testes e a arrumação; decida sem perguntar e me relate
O que não fazer: não faça push para o GitHub nem publique sem aprovação
```

A política é um combinado com a IA, não um mecanismo que a impede. Para limitar o que a IA alcança, use um PC ou um usuário do sistema operacional separado para o trabalho.

## As IAs que você usa

| Agente de IA | O que ele exige |
| --- | --- |
| Claude Code, Codex | Login pela própria CLI |
| GitHub Copilot | Login na GitHub CLI (`gh auth login`). O próprio Copilot já vem incluído |
| Grok Build, pi | Login ou uma chave de API |

Para escolher as IAs que vai usar, ative-as em “Configurações de cada agente”, em “Configurações (engrenagem) → IA”, e pressione “Salvar”. Para dividir o trabalho entre elas, escreva isso na política (“Implementação com o Codex, verificação com o Claude Code”).

As IAs usam os planos e as configurações que você já tem. A cobrança também segue os seus planos.

## Escolher o modelo

Ao lado do botão de enviar do campo de mensagem aparece o modelo que a IA que é seu ponto de contato usa (por exemplo `opus(low)`). Ao tocar nele, abre “IA com quem você fala no campo de mensagem (coordenador)” em “Configurações (engrenagem) → IA”, onde você escolhe essa IA e as IAs alternativas que continuam quando ela para. As IAs responsáveis são escolhidas em “IA das tarefas”, na mesma tela. Para usar outro modelo em um trabalho específico, escreva-o na solicitação ou na política (“Faça este trabalho com o opus”). Uma conversa que passou para uma IA alternativa por limite de uso ou de capacidade continua com essa IA. Para voltar à IA 1, pressione “Limpar conversa” ou mude essa linha nas configurações.

Para adicionar um modelo novo, abra o cartão da IA em “Configurações de cada agente”, em “Configurações (engrenagem) → IA”, acrescente o nome do modelo na linha `model` de “Valores disponíveis ao solicitar trabalho” e pressione “Salvar”.

## Passar uma chave de API

Não escreva a chave no campo de mensagem nem na tela; escreva-a você mesmo em um arquivo.

1. Veja o local em “Arquivo de ambiente”, no final de “Configurações (engrenagem) → Geral” (normalmente `~/.config/alpacawork/env`).
2. Escreva uma por linha, como `ANTHROPIC_API_KEY=...`, e impeça que outros usuários leiam o arquivo: `chmod 600 ~/.config/alpacawork/env`
3. Reinicie o alpacawork ([Parar e iniciar](manage.md#parar-e-iniciar)).
4. Confira se o nome está em “Variáveis de ambiente adicionais”, no cartão da IA. Se não estiver, acrescente e pressione “Salvar”.

## Quantas rodam ao mesmo tempo

No início, até 8 IAs rodam ao mesmo tempo. Se isso gastar demais os seus limites de uso, diminua “Máx. de execuções simultâneas” em “Configurações (engrenagem) → Geral” → “Opções avançadas” e pressione “Salvar”.
