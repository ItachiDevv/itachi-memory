#!/usr/bin/env node
// Clear failed or completed tasks from Supabase
// Usage: node clear-tasks.js <failed|completed>

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const status = process.argv[2];
if (!status || !['failed', 'completed'].includes(status)) {
    console.error('Usage: itachi clear-failed | itachi clear-done');
    process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
    // Get task IDs to clear
    const { data: tasks, error: fetchErr } = await supabase
        .from('itachi_tasks')
        .select('id')
        .eq('status', status);

    if (fetchErr) {
        console.error('Error:', fetchErr.message);
        process.exit(1);
    }

    if (!tasks || tasks.length === 0) {
        console.log(`No ${status} tasks to clear.`);
        return;
    }

    const taskIds = tasks.map(t => t.id);

    // Unlink memories referencing these tasks (set task_id = null)
    const { error: unlinkMemErr } = await supabase
        .from('itachi_memories')
        .update({ task_id: null })
        .in('task_id', taskIds);

    if (unlinkMemErr) {
        console.error('Error unlinking memories:', unlinkMemErr.message);
        process.exit(1);
    }

    // Delete session_edits referencing these tasks
    const { error: editErr } = await supabase
        .from('session_edits')
        .delete()
        .in('task_id', taskIds);

    if (editErr) {
        console.error('Error deleting session_edits:', editErr.message);
        process.exit(1);
    }

    // Delete session_summaries referencing these tasks
    const { error: sumErr } = await supabase
        .from('session_summaries')
        .delete()
        .in('task_id', taskIds);

    if (sumErr) {
        console.error('Error deleting session_summaries:', sumErr.message);
        process.exit(1);
    }

    // Delete the tasks
    const { error } = await supabase
        .from('itachi_tasks')
        .delete()
        .in('id', taskIds);

    if (error) {
        console.error('Error deleting tasks:', error.message);
        process.exit(1);
    }

    console.log(`Cleared ${tasks.length} ${status} task(s).`);
})();
