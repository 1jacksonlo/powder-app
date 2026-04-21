import { supabase } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(request) {
  const { email, password } = await request.json();

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return Response.json({ error: error.message }, { status: 401 });

  await supabaseAdmin
    .from('users')
    .upsert({ id: data.user.id, is_pro: false }, { onConflict: 'id', ignoreDuplicates: true });

  const { data: profile } = await supabaseAdmin
    .from('users')
    .select('is_pro')
    .eq('id', data.user.id)
    .single();

  return Response.json({
    token: data.session.access_token,
    user: { id: data.user.id, email: data.user.email, is_pro: profile?.is_pro ?? false },
  });
}
