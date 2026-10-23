// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Served from GitHub Pages next to the landing page in ../site: https://adrianj98.github.io/kunj/docs/
export default defineConfig({
  site: 'https://adrianj98.github.io',
  base: '/kunj/docs',
  integrations: [
    starlight({
      title: 'kunj',
      description: 'Git branch, worktree and container management with AI commit messages and PR descriptions.',
      logo: { src: './src/assets/logo.svg', replacesTitle: false },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/adrianj98/kunj' }],
      editLink: { baseUrl: 'https://github.com/adrianj98/kunj/edit/main/docs-site/' },
      customCss: ['./src/styles/custom.css'],
      lastUpdated: true,
      sidebar: [
        { label: 'Getting started', items: [{ autogenerate: { directory: 'getting-started' } }] },
        { label: 'Branches', items: [{ autogenerate: { directory: 'branches' } }] },
        { label: 'Commits & pull requests', items: [{ autogenerate: { directory: 'commits-and-prs' } }] },
        { label: 'Worktrees', items: [{ autogenerate: { directory: 'worktrees' } }] },
        { label: 'Containers', items: [{ autogenerate: { directory: 'containers' } }] },
        { label: 'Work logs & team', items: [{ autogenerate: { directory: 'work-logs' } }] },
        { label: 'Configuration', items: [{ autogenerate: { directory: 'configuration' } }] },
        { label: 'Integrations', items: [{ autogenerate: { directory: 'integrations' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
      ],
    }),
  ],
});
