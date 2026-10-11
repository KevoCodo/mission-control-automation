import type { Task } from '../data/tasks';

export function TaskSummary({ tasks }: { tasks: Task[] }) {
  const complete = tasks.filter((task) => task.status === 'done').length;
  const highPriority = tasks.filter((task) => task.priority === 'high').length;
  const active = tasks.length - complete;

  return (
    <section className="summary-grid" aria-label="Task summary">
      <SummaryItem label="Total tasks" value={tasks.length} />
      <SummaryItem label="Active" value={active} />
      <SummaryItem label="Completed" value={complete} />
      <SummaryItem label="High priority" value={highPriority} />
    </section>
  );
}

function SummaryItem({ label, value }: { label: string; value: number }) {
  return (
    <article className="summary-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

