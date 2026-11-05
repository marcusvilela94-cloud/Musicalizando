const MESSAGES: Record<string, string> = {
  room_not_found: "Sala não encontrada. Confira o código.",
  not_owner: "Só quem comanda a sala pode fazer isso.",
  player_not_found: "Você ainda não entrou nesta sala.",
  nickname_required: "Digite um apelido.",
  room_full: "A sala está cheia.",
  team_not_found: "Time não encontrado.",
  team_locked: "No meio da partida não dá para trocar de time.",
  solo_mode: "No modo cada um por si cada jogador é o próprio time.",
  match_running: "A partida está em andamento.",
  need_two_teams: "Precisa de pelo menos 2 times com jogadores.",
  no_tracks: "Nenhuma música para tocar.",
  name_required: "Digite um nome.",
  not_allowed: "Você não pode fazer isso.",
  bad_token: "Token inválido. Recarregue a página.",
  too_many_rooms: "Muitas salas abertas agora. Tente mais tarde.",
  not_host: "Só a tela principal pode fazer isso.",
  no_owner: "O celular do apresentador precisa estar conectado para começar.",
  bad_claim: "Este QR de apresentador já foi usado ou expirou. Escaneie o QR que está na TV agora.",
  round_not_found: "Rodada não encontrada.",
  attempt_not_found: "Tentativa não encontrada.",
  bad_icon: "Esse ícone não está na lista.",
  bad_color: "Essa cor não está na paleta.",
  color_taken: "Outro time já está usando essa cor.",
};

/** Converte erros "npl:codigo" das RPCs em mensagens legíveis. */
export function friendlyError(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  const m = msg.match(/npl:(\w+)/);
  if (m) return MESSAGES[m[1]] ?? m[1];
  if (/fetch|network/i.test(msg)) return "Sem conexão. Tentando de novo…";
  return msg;
}
