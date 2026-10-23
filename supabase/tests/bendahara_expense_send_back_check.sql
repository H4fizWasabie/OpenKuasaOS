-- Bendahara expense send-back check. Run it after
-- 20261125130000_bendahara_expense_send_back.sql, in the same transaction for a dry
-- run, or by itself once the migration is applied. It proves that:
--   * only an owner or admin sends back an approved expense, only with a reason, and
--     not with a payment against it;
--   * an expense approved at RM 100 under Rent, sent back, and approved again at RM 80
--     under Utilities reverses RM 100 of Rent on the send-back day and posts RM 80 of
--     Utilities on the new approval day, and the ledger balances;
--   * rejecting an approved expense reverses its entry the same way;
--   * an expense that has been in the books is not deleted (FIN63), and deleting the
--     workspace still takes everything with it.
-- bendahara_cash_book_check.sql and bendahara_expense_rules_check.sql must still pass
-- beside it. It leaves nothing behind either way: the block always ends with RAISE, so
-- every row and the helper function below are rolled back. Read the message:
--   BENDAHARA_EXPENSE_SEND_BACK_CHECK PASSED ...   or   BENDAHARA_EXPENSE_SEND_BACK_CHECK FAILED: <what went wrong>
-- It acts as each person the way the app does: the authenticated role with that
-- person's id in request.jwt.claims.
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  owner_claims text;
  member_claims text;
  rent uuid;
  utilities uuid;
  bank uuid;
  ex uuid;
  ex2 uuid;
  seen timestamptz;
  my_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  n integer;
  t text;
  fails text[] := '{}';
begin
  execute $f$
    create function public.bendahara_send_back_try(label text, want text, q text) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare
      got text := 'ok';
    begin
      begin
        execute q;
      exception when others then
        got := sqlstate;
      end;
      if got = want then return null; end if;
      return format('%s: expected %s, got %s', label, want, got);
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_send_back_try(text, text, text) to authenticated';

  -- ---- structure --------------------------------------------------------------
  if has_table_privilege('authenticated', 'public.finance_expense_approvals', 'insert')
     or has_table_privilege('authenticated', 'public.finance_expense_approvals', 'update')
     or has_table_privilege('authenticated', 'public.finance_expense_approvals', 'delete')
     or not has_table_privilege('authenticated', 'public.finance_expense_approvals', 'select') then
    fails := array_append(fails, 'authenticated may write finance_expense_approvals, or may not read it');
  end if;
  if has_function_privilege('anon', 'public.finance_send_back_expense(uuid, uuid, timestamptz, text)', 'execute') then
    fails := array_append(fails, 'anon may call finance_send_back_expense');
  end if;

  -- ---- two people and a workspace -----------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@expense-send-back-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id]) as u(id);
  insert into public.orgs (id, name) values (org, 'Expense Send Back Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, owner_id, 'owner'), (org, member_id, 'member');
  select id into rent from public.finance_categories where org_id = org and kind = 'expense' and name = 'Rent';
  select id into utilities from public.finance_categories where org_id = org and kind = 'expense' and name = 'Utilities';
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  if rent is null or utilities is null or bank is null then
    raise exception 'BENDAHARA_EXPENSE_SEND_BACK_CHECK cannot run: the new workspace has no Rent or Utilities category, or no bank account';
  end if;
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;

  -- ==== RM 100 of Rent, approved as the owner saves it, a month ago ==============
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  ex := public.finance_save_expense(org, jsonb_build_object('expense_date', current_date - 30, 'category_id', rent,
    'vendor_name', 'Check Landlord', 'amount', 100));
  select updated_at into seen from public.finance_expenses where id = ex;

  -- ==== refusals ==================================================================
  fails := fails || public.bendahara_send_back_try('sent back with no reason', 'FIN64',
    format('select public.finance_send_back_expense(%L, %L, %L, %L)', org, ex, seen, '  '));
  fails := fails || public.bendahara_send_back_try('sent back by a plain update', 'FIN64',
    format('update public.finance_expenses set status = %L where id = %L', 'pending', ex));
  fails := fails || public.bendahara_send_back_try('sent back and changed in one update', 'FIN01',
    format('update public.finance_expenses set status = %L, amount = 1 where id = %L', 'pending', ex));
  reset role;
  perform set_config('request.jwt.claims', member_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_send_back_try('a member sends back an expense', 'FIN14',
    format('select public.finance_send_back_expense(%L, %L, %L, %L)', org, ex, seen, 'Wrong'));
  reset role;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  if public.finance_send_back_expense(org, ex, seen - interval '1 second', 'Wrong') is not null then
    fails := array_append(fails, 'an expense was sent back as it was before a change');
  end if;

  -- ==== sent back, corrected, approved again ======================================
  if public.finance_send_back_expense(org, ex, seen, ' Wrong category ') is distinct from ex then
    fails := array_append(fails, 'the owner could not send back an approved expense');
  end if;
  select status into t from public.finance_expenses where id = ex;
  if t is distinct from 'pending' then fails := fails || format('a sent-back expense reads %s', t); end if;
  select sent_back_reason into t from public.finance_expense_totals where id = ex;
  if t is distinct from 'Wrong category' then fails := fails || format('a sent-back expense gives the reason %s', t); end if;
  perform public.finance_save_expense(org, jsonb_build_object('id', ex, 'expense_date', current_date - 30,
    'category_id', utilities, 'vendor_name', 'Check Landlord', 'amount', 80));

  -- What the books say, line by line: the first approval, its reversal today, the second today.
  select string_agg(format('%s %s %s %s', l.entry_key, l.entry_date, a.name, l.debit - l.credit), '; '
                    order by l.entry_key, a.name) into t
    from public.finance_ledger_lines l
    join public.finance_ledger_accounts a on a.id = l.account_id
   where l.source_id = ex;
  if t is distinct from format('expense:%s %s Accrued Expenses -100.00; ', ex, current_date - 30)
       || format('expense:%s %s Rent 100.00; ', ex, current_date - 30)
       || format('expense:%s:2 %s Accrued Expenses -80.00; ', ex, my_today)
       || format('expense:%s:2 %s Utilities 80.00; ', ex, my_today)
       || format('expense:%s:reverse %s Accrued Expenses 100.00; ', ex, my_today)
       || format('expense:%s:reverse %s Rent -100.00', ex, my_today) then
    fails := fails || format('the sent-back expense is in the books as: %s', t);
  end if;

  -- ==== paid in part: not sent back, not rejected ===================================
  perform public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'txn_date', current_date, 'method', 'fpx', 'party_name', 'Check Landlord', 'status', 'posted'),
    jsonb_build_array(jsonb_build_object('expense_id', ex, 'amount', 10)));
  select updated_at into seen from public.finance_expenses where id = ex;
  fails := fails || public.bendahara_send_back_try('an expense with a payment is sent back', 'FIN02',
    format('select public.finance_send_back_expense(%L, %L, %L, %L)', org, ex, seen, 'Too late'));

  -- ==== an approved expense rejected: reversed; and kept ===========================
  ex2 := public.finance_save_expense(org, jsonb_build_object('category_id', rent, 'vendor_name', 'Typo', 'amount', 5));
  update public.finance_expenses set status = 'rejected', updated_at = now() where id = ex2;
  select count(*) into n from public.finance_ledger_lines
   where source_id = ex2 and entry_key = 'expense:' || ex2 || ':reverse' and entry_date = greatest(current_date, my_today)
     and description = 'Rejected: Expense to Typo';
  if n <> 2 then fails := fails || format('a rejected approved expense has %s reversal lines, expected 2', n); end if;
  fails := fails || public.bendahara_send_back_try('an expense that has been in the books is deleted', 'FIN63',
    format('delete from public.finance_expenses where id = %L', ex2));

  -- Every entry of the workspace balances.
  select count(*) into n from (
    select entry_key from public.finance_ledger_lines where org_id = org group by entry_key having sum(debit) <> sum(credit)
  ) d;
  if n <> 0 then fails := fails || format('%s entries do not balance', n); end if;
  reset role;

  -- ==== the workspace is deleted, with everything in it ============================
  perform set_config('request.jwt.claims', '{}', true);
  delete from public.orgs where id = org;
  select (select count(*) from public.finance_expenses where org_id = org)
       + (select count(*) from public.finance_expense_approvals where org_id = org) into n;
  if n <> 0 then fails := fails || format('deleting the workspace left %s expense rows', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_EXPENSE_SEND_BACK_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_EXPENSE_SEND_BACK_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
