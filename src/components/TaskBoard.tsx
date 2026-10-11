import type { Task } from '../data/tasks';

const statusLabels: Record<Task['status'], string> = {
  todo: 'To do',
  inProgress: 'In progress',
  done: 'Done'
};

const statuses: Task['status'][] = ['todo', 'inProgress', 'done'];

export function TaskBoard({ tasks }: { tasks: Task[] }) {
  return (
    <section className="task-board" aria-label="Task board">
      {statuses.map((status) => {
        const statusTasks = tasks.filter((task) => task.status === status);

        return (
          <article className="task-column" key={status}>
            <header className="column-header">
              <h2>{statusLabels[status]}</h2>
              <span>{statusTasks.length}</span>
            </header>
            <div className="task-list">
              {statusTasks.map((task) => (
                <div className="task-card" key={task.id}>
                  <div className="task-card-header">
                    <h3>{task.title}</h3>
                    <span className={`priority priority-${task.priority}`}>
                      {task.priority}
                    </span>
                  </div>
                  <p>{task.description}</p>
                  <div className="task-meta">
                    <span>{task.owner}</span>
                    <span>{task.dueDate}</span>
                  </div>
                </div>
              ))}
            </div>
          </article>
        );
      })}
    </section>
  );
}

