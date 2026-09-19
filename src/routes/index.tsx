import { createFileRoute } from '@tanstack/react-router';
import { HostStudio } from '../host-studio';

export const Route = createFileRoute('/')({
  component: HostStudio,
});
