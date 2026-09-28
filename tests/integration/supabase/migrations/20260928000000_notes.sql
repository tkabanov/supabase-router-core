-- Table used to prove that user-scoped clients created by the router enforce RLS
create table public.notes (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  body text not null
);

alter table public.notes enable row level security;

create policy own_notes on public.notes
  for select to authenticated
  using (user_id = auth.uid());

grant select on public.notes to authenticated;
