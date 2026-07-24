import { Router, type IRouter } from "express";
import healthRouter from "./health";
import meRouter from "./me";
import usersRouter from "./users";
import seedsRouter from "./seeds";
import onboardingRouter from "./onboarding";
import portraitRouter from "./portrait";
import divesRouter from "./dives";
import ratingsRouter from "./ratings";
import linksRouter from "./links";
import metricsRouter from "./metrics";
import timelineRouter from "./timeline";
import spotifyRouter from "./spotify";

const router: IRouter = Router();

router.use(healthRouter);
router.use(meRouter);
router.use(usersRouter);
router.use(seedsRouter);
router.use(onboardingRouter);
router.use(portraitRouter);
router.use(divesRouter);
router.use(ratingsRouter);
router.use(linksRouter);
router.use(metricsRouter);
router.use(timelineRouter);
router.use(spotifyRouter);

export default router;
