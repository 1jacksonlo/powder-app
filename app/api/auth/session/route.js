import { supabaseAdmin } from '@/lib/supabase';

export async function GET(request) {
  const token = request.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return Response.json({ user: null });

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return Response.json({ user: null });

  const { data: profile } = await supabaseAdmin
    .from('users')
    .select('is_pro')
    .eq('id', user.id)
    .single();

  return Response.json({ user: { id: user.id, email: user.email, is_pro: profile?.is_pro ?? false } });
}
