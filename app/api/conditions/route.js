import { supabaseAdmin } from '@/lib/supabase';

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('resort_conditions')
    .select('*');

  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Convert array to map keyed by resort name for easy lookup
  const map = {};
  for (const row of data || []) {
    map[row.resort_name] = row;
  }

  return Response.json(map);
}
