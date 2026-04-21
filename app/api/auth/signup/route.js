import { supabaseAdmin } from '@/lib/supabase';

export async function POST(request) {
  const { email, password } = await request.json();

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    console.error('Signup error:', error);
    return Response.json({ error: error.message }, { status: 400 });
  }

  await supabaseAdmin.from('users').insert({ id: data.user.id, is_pro: false });

  return Response.json({ success: true });
}
