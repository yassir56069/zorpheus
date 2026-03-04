export interface DbUser {
    id: number;
    userDiscordId: string;
    userDisplayName: string;
    userLastFMUserName: string | null;
    userRYMUserName: string | null;
    createdAt: string;
    ModifiedAt: string | null;
}