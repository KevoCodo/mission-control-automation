export type TaskStatus = 'todo' | 'inProgress' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  owner: string;
  dueDate: string;
}

export const sampleTasks: Task[] = [
  {
    id: 1,
    title: 'Define task intake workflow',
    description: 'Document the fields needed to capture and prioritize new delivery tasks.',
    status: 'todo',
    priority: 'high',
    owner: 'Product',
    dueDate: 'Oct 18'
  },
  {
    id: 2,
    title: 'Sketch dashboard states',
    description: 'Prepare empty, loading, and active task board states for the first release.',
    status: 'inProgress',
    priority: 'medium',
    owner: 'Design',
    dueDate: 'Oct 20'
  },
  {
    id: 3,
    title: 'Choose analytics events',
    description: 'Identify the task creation and completion events the app should track.',
    status: 'inProgress',
    priority: 'low',
    owner: 'Engineering',
    dueDate: 'Oct 23'
  },
  {
    id: 4,
    title: 'Publish project setup guide',
    description: 'Add local development, testing, and build instructions to the README.',
    status: 'done',
    priority: 'high',
    owner: 'Engineering',
    dueDate: 'Oct 15'
  }
];

