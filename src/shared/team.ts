/** Our own team, not a contact at a company. An explicit 'external' mark always wins; stored contact data is never edited.
 * `app_settings` key `directory:team` ({"telegramUserIds":[...],"usernames":[...]}) pins people by Telegram ID or username,
 * because the extractor rewrites a contact's affiliation and names. `members:false` omits the workspace-member
 * link for read models that run without the access tables. Usernames match case-insensitively, with or without '@'; any @antseed.* email marks an employee. */
export const internalContactSql = (p: string, { members = true } = {}) => `(${p}.affiliation='internal' OR (${p}.affiliation<>'external' AND (
  array_to_string(${p}.names||${p}.usernames,' ') ~* 'ant\\s?seed'
  OR array_to_string(${p}.emails,' ') ~* '@antseed\\.'
  OR EXISTS(SELECT 1 FROM unnest(${p}.usernames) team_u WHERE lower(ltrim(team_u,'@')) IN (
    SELECT lower(ltrim(jsonb_array_elements_text(coalesce(value->'usernames','[]'::jsonb)),'@')) FROM app_settings WHERE key='directory:team'))
  OR EXISTS(SELECT 1 FROM contact_telegram_ids t WHERE t.contact_id=${p}.id AND (
    t.telegram_user_id IN (SELECT self_user_id FROM telegram_account)
    OR t.telegram_user_id IN (SELECT jsonb_array_elements_text(coalesce(value->'telegramUserIds','[]'::jsonb))::bigint FROM app_settings WHERE key='directory:team')
    ${members ? 'OR t.telegram_user_id IN (SELECT telegram_user_id FROM workspace_members WHERE telegram_user_id IS NOT NULL)' : ''})))))`;
