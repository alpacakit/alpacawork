# Solução de problemas

Se a tela abre, o caminho mais rápido é perguntar à IA no campo de mensagem (“Por que a tarefa do formulário de reservas não avança?”). A IA consegue ler os passos para resolver.

Não apague por conta própria a pasta de dados (`~/alpacawork`) nem os arquivos de registro para recomeçar.

## Uma tarefa parou

Em uma tarefa em “Requer atenção”, a execução da IA parou. Ao abrir, o motivo aparece abaixo do título.

- “Falhou”: pressione “Tentar novamente” ou “Parar”. Se quiser que a IA faça de outro jeito, escreva no campo de mensagem e envie, em vez de usar os botões. Se o motivo for o limite de uso ou o modelo congestionado, pressione “Tentar novamente” quando o limite de uso for renovado, ou peça no campo de mensagem: “Tente de novo com outro modelo”. Mesmo depois que o limite é renovado, o trabalho não é retomado sozinho.
- “Limite atingido”: a troca automática entre as IAs chegou ao número fixo de vezes (no início, 20). Se quiser que continue, pressione “Continuar”.
- Motivos sem botões (“Recebimento não confirmado”, “Sem perfil de inicialização” e outros): leia o texto mostrado e dê uma instrução no campo de mensagem, como “Continue”. O significado de cada um está em [Motivos de parada](reference.md#motivos-de-parada).

## Enviei, mas nada avança

A situação do envio aparece acima do campo de mensagem. Pressione-a para abrir a conversa com a IA que é seu ponto de contato.

- “Enviando…”, “Na fila”, “Trabalhando nisso…” e parecidos: aguarde.
- “Não enviada (motivo)”: leia o motivo, corrija e envie de novo.
- “Não foi possível confirmar se chegou”: abra a conversa e pressione “Enviar novamente” ou “Cancelar”.
- “Não foi possível receber uma resposta”: pressione “Enviar novamente”. Os anexos não são reenviados; se a solicitação tinha anexos, escreva de novo e envie. Se for o limite de uso, espere o limite ser renovado ou escolha outro modelo antes de enviar.
- “Não foi possível iniciar o coordenador.”: veja “Os agentes de IA não funcionam”, abaixo.

## Não sei se a tarefa está em andamento

- Se o tempo na linha em “Em andamento” está aumentando, a IA está trabalhando.
- “A última saída é antiga”: não quer dizer que parou. Aguarde um pouco e, se nada mudar, pergunte no campo de mensagem.
- “Na fila” na linha: chegou ao limite de execuções simultâneas e está esperando uma vaga.
- “Aguarda T12” na linha: está esperando a T12 terminar. Se a T12 parou, resolva a T12 primeiro.

## Reiniciei o PC ou ele entrou em suspensão

Quando você faz login no PC, o alpacawork inicia sozinho, e as tarefas continuam como estavam. O trabalho que estava rodando antes de reiniciar para. Abra as tarefas que passaram para “Requer atenção” e pressione “Tentar novamente”. Elas não são retomadas sozinhas.

Durante a suspensão, o trabalho não avança. Em um notebook, fechar a tampa faz parar.

## A tela não abre

Se aparece “Não é possível acessar esse site”, o alpacawork não está rodando. Inicie-o e recarregue a página.

- Execute `alpacawork start` no terminal.
- Windows: abra o Ubuntu pelo menu Iniciar, e o alpacawork inicia junto. Deixe a janela aberta. Se ainda assim não abrir, execute `alpacawork start` nessa janela.

Se esqueceu a URL, veja [Abrir a tela de novo](manage.md#abrir-a-tela-de-novo).

De outros dispositivos, não dá para abrir `http://127.0.0.1:...`. Use a URL `https://` de [Usar pelo celular](remote.md#usar-pelo-celular) ou de [um PC acessado por SSH](manage.md#se-você-instalou-em-um-pc-acessado-por-ssh).

Se o alpacawork não inicia depois de você atualizar o Node.js, execute `alpacawork setup` e pressione Enter.

## Aparece “Offline” ou outro aviso

- “Você está offline” ou “Aguardando a resposta do alpacawork.”: confira se o alpacawork está rodando (“A tela não abre”, acima). Quando a conexão volta, tudo volta sozinho.
- “A versão do alpacawork mudou.”: pressione “Recarregar”.
- “Esta máquina está com carga alta”: em “Ver”, confira o que está pesado e diminua as execuções simultâneas.

## Os agentes de IA não funcionam

O estado aparece em “Agentes”, em “Configurações (engrenagem) → Servidor”.

- “Login necessário”: execute o comando de login no terminal.

  | Agente de IA | Comando |
  | --- | --- |
  | Claude Code | `claude auth login` |
  | Codex | `codex login` |
  | GitHub Copilot | `gh auth login` |

- “Não encontrado”: se não estiver instalado, instale. Se estiver, indique o local em “Executável”, no cartão.
- “Nenhum agente está ativado”: ative as IAs que vai usar.

Depois de corrigir, use “Tentar novamente” nas tarefas que tinham parado.

## A instalação para

Corrija a causa mostrada e execute o mesmo comando de novo; ele continua de onde parou.

- `requires Node >=24.16.0`: instale o Node.js 24 e execute de novo.
- `command not found`: abra o terminal de novo.
- Erros de permissão de escrita, `does not run as root`: execute sem `sudo`, com um Node.js instalado pelo nvm ou parecido.
- `User service manager is unavailable`: no WSL2, [ative o systemd](manage.md#no-windows).

Para outras mensagens, cole o texto mostrado, sem alterar, na conversa com a IA e peça ajuda.

## O que passar à IA ao pedir ajuda

Abra o Claude Code ou o Codex no terminal, chame a skill alpacawork (`/alpacawork` ou `$alpacawork`) e passe:

- O texto mostrado, como está, e o número da tarefa (como T12)
- O que você fez antes de acontecer
- A saída de `alpacawork workspace url`

Bugs vão para as [Issues](https://github.com/alpacakit/alpacawork/issues). Vulnerabilidades não vão em uma Issue; informe seguindo o [SECURITY.md](https://github.com/alpacakit/alpacawork/blob/main/SECURITY.md).
