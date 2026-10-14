create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  role text not null default 'user',
  created_at timestamptz not null default now()
);

create unique index users_email_key on users (lower(email));
