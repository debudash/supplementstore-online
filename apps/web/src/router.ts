// Route registry (AGENTS.md section 5). T0 pre-registers EVERY view. Later tasks
// replace only their own view file; routes and role metadata stay here.
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import type { Role } from './api/users'

import Home from './views/Home.vue'
import OrderBuilder from './views/provider/OrderBuilder.vue'
import Orders from './views/provider/Orders.vue'
import OrderAudit from './views/provider/OrderAudit.vue'
import Recurring from './views/provider/Recurring.vue'
import Dashboard from './views/provider/Dashboard.vue'
import ProviderPayables from './views/provider/Payables.vue'
import Pay from './views/patient/Pay.vue'
import MyOrders from './views/patient/MyOrders.vue'
import ScheduleAuthorize from './views/patient/ScheduleAuthorize.vue'
import Metrics from './views/admin/Metrics.vue'
import Inventory from './views/admin/Inventory.vue'
import Operations from './views/admin/Operations.vue'
import DemoData from './views/admin/DemoData.vue'
import AdminPayables from './views/admin/Payables.vue'

declare module 'vue-router' {
  interface RouteMeta {
    // Roles permitted to see this route's tab. Omitted = not shown as a tab.
    roles?: Role[]
    // Label shown in the top-bar tab list for the matching role(s).
    tab?: string
  }
}

export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: Home },

  // Provider
  { path: '/orders/new', name: 'order-new', component: OrderBuilder, meta: { roles: ['provider'], tab: 'New Order' } },
  { path: '/orders', name: 'orders', component: Orders, meta: { roles: ['provider'], tab: 'Orders' } },
  { path: '/orders/:id/audit', name: 'order-audit', component: OrderAudit, meta: { roles: ['provider'] } },
  { path: '/recurring', name: 'recurring', component: Recurring, meta: { roles: ['provider'], tab: 'Recurring' } },
  { path: '/dashboard', name: 'dashboard', component: Dashboard, meta: { roles: ['provider'], tab: 'Dashboard' } },
  { path: '/payables', name: 'payables', component: ProviderPayables, meta: { roles: ['provider'], tab: 'Payables' } },

  // Patient. My Orders is a real tab; the pay/authorize pages are reached by an
  // unguessable token link (no tab), but are tagged as patient routes for clarity.
  { path: '/my-orders', name: 'my-orders', component: MyOrders, meta: { roles: ['patient'], tab: 'My Orders' } },
  { path: '/pay/:token', name: 'pay', component: Pay, meta: { roles: ['patient'] } },
  { path: '/pay/schedule/:token', name: 'pay-schedule', component: ScheduleAuthorize, meta: { roles: ['patient'] } },

  // Cerbo Admin
  { path: '/admin/metrics', name: 'admin-metrics', component: Metrics, meta: { roles: ['cerbo_admin'], tab: 'Metrics' } },
  { path: '/admin/inventory', name: 'admin-inventory', component: Inventory, meta: { roles: ['cerbo_admin'], tab: 'Inventory' } },
  { path: '/admin/operations', name: 'admin-operations', component: Operations, meta: { roles: ['cerbo_admin'], tab: 'Operations' } },
  { path: '/admin/demo', name: 'admin-demo', component: DemoData, meta: { roles: ['cerbo_admin'], tab: 'Demo Data' } },
  { path: '/admin/payables', name: 'admin-payables', component: AdminPayables, meta: { roles: ['cerbo_admin'], tab: 'Payables' } }
]

export const router = createRouter({
  history: createWebHistory(),
  routes
})
