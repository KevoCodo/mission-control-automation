import { DashboardHeader } from './components/DashboardHeader';
import { TaskBoard } from './components/TaskBoard';
import { TaskSummary } from './components/TaskSummary';
import { sampleTasks } from './data/tasks';

export function App() {
  return (
    <main className="app-shell">
      <DashboardHeader />
      <TaskSummary tasks={sampleTasks} />
      <TaskBoard tasks={sampleTasks} />
    </main>
  );
}

