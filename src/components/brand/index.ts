/**
 * The brand layer: the parts of the interface that belong to the railway rather than to the app.
 *
 * A roundel, a countdown, a trunk line's colour, the way a station's name is set, the words used
 * for how a line is running. These follow the MTA's own system, and they are separated from
 * src/components/ui — which follows the platform's — so that neither quietly borrows from the
 * other. The split is the whole design argument: signage where the subject is the railway,
 * interface where the subject is the application.
 */
export { default as RouteBullet, isExpress, type BulletSize } from "./RouteBullet";
export { default as BulletGroup } from "./BulletGroup";
export { default as Countdown } from "./Countdown";
export { default as ServiceStatus, type Status } from "./ServiceStatus";
export { default as DirectionHeading } from "./DirectionHeading";
export { default as StationName } from "./StationName";
export { default as TrunkStripe } from "./TrunkStripe";
