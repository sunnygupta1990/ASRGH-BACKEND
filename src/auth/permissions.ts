import { NextFunction, Request, Response } from "express";

export const PERMISSIONS = {
  dashboardRead: "dashboard.read",
  membersRead: "members.read",
  membersWrite: "members.write",
  membersDelete: "members.delete",
  eventsRead: "events.read",
  eventsWrite: "events.write",
  eventsDelete: "events.delete",
  photosRead: "photos.read",
  photosWrite: "photos.write",
  photosDelete: "photos.delete",
  socialWorkRead: "social_work.read",
  socialWorkWrite: "social_work.write",
  socialWorkDelete: "social_work.delete",
  announcementsRead: "announcements.read",
  announcementsWrite: "announcements.write",
  announcementsDelete: "announcements.delete",
  contactsRead: "contacts.read",
  contactsWrite: "contacts.write",
  notificationsRead: "notifications.read",
  notificationsWrite: "notifications.write",
  settingsRead: "settings.read",
  settingsWrite: "settings.write",
  importExport: "import_export.manage",
  auditRead: "audit.read",
  adminUsersRead: "admin_users.read",
  adminUsersWrite: "admin_users.write",
  rolesManage: "roles.manage",
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export function requirePermission(permission: PermissionCode) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.authorization?.isSystemRole || req.authorization?.permissions.has(permission)) {
      next();
      return;
    }

    return res.status(403).json({
      success: false,
      message: "Insufficient permission",
      requiredPermission: permission,
    });
  };
}
