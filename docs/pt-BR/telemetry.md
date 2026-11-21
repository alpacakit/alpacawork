# Dados de uso

Os dados de uso são uma contagem de como o alpacawork é usado (quais ações foram usadas e quantas vezes, a versão, o sistema operacional e assim por diante). Eles são enviados ao desenvolvedor para melhorar o alpacawork: para saber quais recursos são usados, onde ocorrem falhas e onde a tela está lenta.

O envio é opcional. Nada é enviado até você escolher, e o alpacawork funciona da mesma forma se você não enviar. Depois de escolher enviar, você pode parar a qualquer momento e excluir o que foi enviado.

## O que é enviado

Para cada dia em que você usa o alpacawork, os dados daquele dia são reunidos em um relatório e enviados no dia seguinte. Os dias são contados em UTC. Nenhum relatório é enviado nos dias em que você não usa o alpacawork. Se um relatório não puder ser enviado, o envio é tentado novamente por 7 dias; depois disso, ele é excluído sem ser enviado.

Um relatório contém:

- **Contagens de ações**: ações na tela (pressionar o botão de enviar, buscar e assim por diante) e alterações feitas por comandos de uma IA ou do terminal (criar uma tarefa, relatar o status dela e assim por diante), contadas por tipo. Cada contagem também traz o tipo de dispositivo (celular, tablet ou PC) e o sistema operacional dele, por onde a ação foi feita (por uma pessoa na tela, por uma IA ou pelo terminal, além do tipo de IA quando foi uma IA) e o idioma de exibição e o tema da tela
- **Ambiente**: a versão do alpacawork, o sistema operacional e o tipo de CPU, e a versão do Node
- **Trabalho da IA**: os tipos de IA usados (`claude`, `codex` e assim por diante; os nomes que você deu a elas não são enviados), as contagens por nível de esforço e quantas vezes o trabalho falhou no meio do caminho
- **Tamanho**: o número de projetos e de tarefas, a profundidade da árvore de tarefas, quantas vezes uma IA trabalhou em uma mesma tarefa, quantas execuções de IA estavam em andamento ao mesmo tempo e assim por diante
- **Velocidade de exibição**: quanto tempo levou desde a abertura da tela ou de uma tarefa até o conteúdo aparecer
- **Sobre o próprio relatório**: a data do relatório, o número do formato e o ID deste PC

Cada tipo de ação tem um nome fixo. O texto que você digita e os títulos das tarefas nunca passam a fazer parte de um nome. O tamanho, a velocidade de exibição e as contagens de falhas são enviados em faixas aproximadas, como `10-19`.

O ID deste PC é um valor aleatório criado quando você escolhe enviar pela primeira vez. Ele não é gerado a partir de nenhuma informação sobre o PC ou o usuário. É usado para contar por quantos dias o mesmo PC continua em uso e para permitir que você exclua depois os dados enviados. Se você parar de enviar e começar de novo, o mesmo ID é usado.

Você pode ver o relatório real exatamente como ele será enviado (“Ver o que é enviado”, abaixo).

## O que não é enviado

- Títulos e texto das tarefas, conversas, o texto das solicitações
- Nomes de arquivos e pastas, URLs de repositórios
- Nomes do PC e do usuário, endereços de e-mail
- O texto dos erros (só se conta quantas vezes ocorreram erros)

Os endereços IP não são incluídos nos relatórios, e o serviço de recebimento não os armazena. No entanto, a Cloudflare, que hospeda o serviço de recebimento, lida com eles durante a transmissão ([política de privacidade da Cloudflare](https://www.cloudflare.com/pt-br/privacypolicy/)).

## Escolher se quer enviar e parar o envio

Você escolhe na segunda etapa da tela de configuração inicial, que é onde uma nova instalação abre. Nada é enviado até você escolher; sem uma escolha (por exemplo, em um workspace criado antes de a tela de configuração inicial existir), nada é enviado e a tela não pergunta.

Para mudar sua escolha depois, use a chave “Enviar dados de uso para ajudar a melhorar o alpacawork”, no final de Configurações → Servidor. Desativá-la interrompe o envio; ativá-la o inicia. Se você só quer parar, também pode executar `alpacawork telemetry off`.

Quando você para, os dados ainda não enviados são excluídos sem serem enviados. Os dados já enviados não são excluídos só por você parar (“Excluir o que foi enviado”, abaixo).

Se você atualizar para uma versão que muda quais campos são enviados ou como eles são enviados, a pergunta é feita de novo somente se você tinha escolhido enviar. Nada é enviado até você responder.

Em alguns casos, como quando o alpacawork é executado em CI ou dentro de um contêiner, nada é enviado mesmo que você tenha escolhido enviar. Nesses casos, a chave não pode ser alterada, e o motivo aparece abaixo dela.

Também não é enviado nada enquanto a variável de ambiente `ALPACAWORK_TELEMETRY_DISABLED=1` ou `DO_NOT_TRACK=1` estiver definida para o servidor. No entanto, quando você a remove, todos os dados não enviados dos últimos 7 dias são enviados. Além disso, variáveis de ambiente definidas em um terminal não chegam ao servidor que inicia automaticamente. Para garantir que o envio pare, use a tela ou o comando.

## Ver o que é enviado

- Tela: “Ver o que é enviado”, abaixo da chave de dados de uso no final de Configurações → Servidor, mostra o relatório de hoje até o momento (o que será enviado amanhã), exatamente como ele será enviado. Só há conteúdo ali enquanto o envio está ativado. O que aparece ali ainda não foi enviado; portanto, se você parar o envio, não será enviado.
- Comando: `alpacawork telemetry show` mostra os dados de hoje até o momento, os relatórios de dias anteriores ainda não enviados, as suas cópias dos relatórios já enviados e a lista de nomes e valores que podem ser enviados. A lista é mostrada mesmo antes de você escolher enviar.

Os dois mostram JSON. Os comandos `alpacawork telemetry` só funcionam quando uma pessoa os digita em um terminal neste PC.

## Excluir o que foi enviado

- Tela: use “Excluir dados enviados”, abaixo da chave de dados de uso no final de Configurações → Servidor. Isso funciona mesmo depois de você ter parado de enviar. Os dados que estão no PC e ainda não foram enviados também são excluídos.
- Página de exclusão: informe o ID deste PC em <https://alpacakit-telemetry.alpacakit.workers.dev/delete>. Use-a quando não conseguir abrir a tela do alpacawork ou para excluir dados de um PC que você não usa mais. Você encontra o ID na janela que “Excluir dados enviados” abre, ou como `id` em `alpacawork telemetry status`.

A exclusão remove os relatórios enviados com esse ID e o registro desse ID (o primeiro e o último dia em que ele enviou). Não é possível remover dados de totais que não distinguem um PC do outro (como o número de ações ou de PCs por dia).

Excluir não interrompe o envio. Se o envio continuar, os novos dados são enviados com o mesmo ID. A página de exclusão não exclui o que está no PC; por isso, se esse PC ainda estiver enviando, pare o envio primeiro e depois exclua. Caso contrário, os dados ainda não enviados serão enviados mais tarde.

## Para onde vão, quem pode ver e por quanto tempo ficam guardados

- Para onde: o serviço de recebimento que o desenvolvedor configurou no Cloudflare Workers (`https://alpacakit-telemetry.alpacakit.workers.dev/v1/report`).
- Quem: somente o desenvolvedor do alpacawork. O painel de totais exige login e mostra as contagens como elas são, inclusive as pequenas. Quando as contagens são publicadas, os grupos com menos de 10 PCs ficam de fora, e as contagens são identificadas como vindas apenas de PCs que escolheram enviar.
- Por quanto tempo: cada relatório é mantido com o seu ID por cerca de 3 meses e depois excluído. O registro de um ID é excluído cerca de 3 meses depois do último dia em que ele enviou. Os totais que não incluem o ID são mantidos por tempo indeterminado. Não é possível rastreá-los até os relatórios de PCs individuais.
