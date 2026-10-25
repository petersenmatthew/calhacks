/**
 * Whether something the controller said is a standing rule for future cases rather than an instruction
 * about this one case. Used to route it to the Controls Lead and to say so on the confirm card.
 * The live model also judges this; this check catches the common ways people phrase a rule.
 */
export function looksLikeRule(text: string | null | undefined): boolean {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const forward = /going forward|from now on|in (the )?future|next time|for future|always|every time|whenever|as a rule|by default|make (it|this|that) (a )?(rule|policy|standard)|new (rule|policy)|\bpolicy\b|\brule\b|standard practice/.test(t);
  const structure =
    /\bown(s|er|ers|ing)?\b|team that|which team|who pays|usage|split|proportional|reserv|idle|threshold|limit|auto-?(book|post|approve)|under \$|over \$|less than \$|more than \$|materiality/.test(t);
  const money = /\bpay|\bbill|charg|allocat|split|disput|\bbook|credit|approv/.test(t);
  return forward || (structure && money);
}
