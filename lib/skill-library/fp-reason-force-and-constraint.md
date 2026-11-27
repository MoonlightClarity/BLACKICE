# Reason About Forces and Constraints

Use this method when a mechanical explanation depends on forces, motion, support, contact, or geometry. Define the body and its constraints before writing equations. Separate forces acting on the selected body from reaction forces acting on other bodies.

## Primitives

Identify the body or system, reference frame, mass, position, velocity, acceleration, external forces, moments, contact conditions, and constraints. For constant mass in an inertial frame, net external force equals mass times acceleration. Static equilibrium also requires appropriate moment balance.

## Procedure

1. Select a boundary around the object or connected system. List external interactions crossing it: gravity, contact, tension, pressure, drag, springs, or applied forces.
2. Draw a free-body representation with directions and points of application. Internal action-reaction pairs cancel only when both interacting bodies are inside the selected system.
3. Choose axes and sign conventions. Resolve vectors consistently rather than mixing force magnitudes with signed components.
4. State the regime: static equilibrium, constant velocity, acceleration, slipping, rolling, or impending motion. Derive equations appropriate to that regime.
5. Add constraints separately. An ideal rope constrains length; a normal contact can push but may lose contact; static friction adjusts within its permitted bound.
6. Solve for unknown forces or motion, then check whether the assumed regime remains valid. If a computed contact force requires pulling through a nonadhesive surface, the contact assumption fails.
7. For rotational effects, include moment arms and the appropriate rotational dynamics. A zero net force does not imply zero net torque.
8. Check units, limiting cases, and an independent energy or momentum calculation where it can expose a contradiction without duplicating the entire solution.

## Worked example

A 10 kg block rests on a horizontal surface with a static friction coefficient of 0.4. Using g = 9.81 m/s squared, the normal force is 98.1 N when no other vertical force acts. The maximum static friction is 39.24 N. A 20 N horizontal push can be balanced by 20 N of static friction, so the block can remain at rest. Substituting 39.24 N as the actual friction would incorrectly predict acceleration opposite the push.

## Output and check

Return the system boundary, free-body model, equations, solved quantities, and consistency checks on contact and friction regimes. State approximations such as rigid body, negligible drag, or ideal rope only where they matter to the result.

## Failure boundary

Do not add an extra “force of motion” merely because an object moves. Constant velocity requires zero net force in the selected inertial frame, not zero individual forces. Variable-mass systems and rotating frames need additional care; blindly applying the simplest constant-mass equation can omit momentum flux or frame effects.

## Reference

- [NASA: Newton's Laws of Motion](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/newtons-laws-of-motion/)
